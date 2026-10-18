import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

const { config } = await import('../../src/config.ts')
const { query } = await import('../../src/db/pool.ts')
const { rankDetailed, rewriteApplyMessage } = await import('../../src/campaigns/rank.ts')
const { getCampaign, sampleDetail, seedCampaign } = await import('./campaign-helpers-rank.ts')

const score = (id: number, s: number, applyMessage = '안녕하세요. 신청합니다.') => ({
  id,
  score: s,
  reason: `이유 ${id}`,
  applyMessage,
})

describe('rankDetailed', () => {
  beforeEach(() => {
    chatJson.mockReset()
    config.CAMPAIGN_DAILY_MAX = 2
  })

  it('skips by rule, shortlists the top N and skips the rest', async () => {
    const visit = await seedCampaign({ type: 'visit' })
    const cheap = await seedCampaign({ rewardWon: 1000 })
    const a = await seedCampaign()
    const b = await seedCampaign()
    const c = await seedCampaign()
    chatJson.mockResolvedValueOnce({
      scores: [score(a, 6), score(b, 9), score(c, 3), score(999, 10)],
    })

    const shortlisted = await rankDetailed()

    expect(shortlisted).toEqual([b, a])
    expect((await getCampaign(visit)).skip_reason).toBe('유형: 방문형')
    expect((await getCampaign(visit)).status).toBe('SKIPPED')
    expect((await getCampaign(cheap)).skip_reason).toBe('제공 가치 낮음')
    const rowB = await getCampaign(b)
    expect(rowB.status).toBe('SHORTLISTED')
    expect(Number(rowB.score)).toBe(9)
    expect(rowB.apply_message).toBe('안녕하세요. 신청합니다.')
    const rowC = await getCampaign(c)
    expect(rowC.status).toBe('SKIPPED')
    expect(rowC.skip_reason).toBe('선별 탈락: 이유 3')
  })

  it('leaves candidates the model omitted as DETAILED', async () => {
    const a = await seedCampaign()
    const b = await seedCampaign()
    chatJson.mockResolvedValueOnce({ scores: [score(a, 8)] })
    expect(await rankDetailed()).toEqual([a])
    expect((await getCampaign(b)).status).toBe('DETAILED')
  })

  it('subtracts campaigns already reviewed today from the quota', async () => {
    await seedCampaign({ status: 'PENDING_REVIEW', applyMessage: 'x' })
    // Reviewed on an earlier day: does not count.
    await seedCampaign({
      status: 'APPLIED',
      updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    })
    const a = await seedCampaign()
    const b = await seedCampaign()
    chatJson.mockResolvedValueOnce({ scores: [score(a, 5), score(b, 9)] })

    expect(await rankDetailed()).toEqual([b])
    expect((await getCampaign(a)).status).toBe('SKIPPED')
  })

  it('does not call the LLM when the quota is used up', async () => {
    await seedCampaign({ status: 'PENDING_REVIEW', applyMessage: 'x' })
    await seedCampaign({ status: 'APPROVED', applyMessage: 'x' })
    const a = await seedCampaign()
    expect(await rankDetailed()).toEqual([])
    expect(chatJson).not.toHaveBeenCalled()
    expect((await getCampaign(a)).status).toBe('DETAILED')
  })

  it('enforces the apply message length', async () => {
    const a = await seedCampaign()
    chatJson
      .mockResolvedValueOnce({ scores: [score(a, 8, '가'.repeat(500))] })
      .mockResolvedValueOnce({ text: '나'.repeat(400) })
    await rankDetailed()
    const row = await getCampaign(a)
    expect([...(row.apply_message ?? '')].length).toBeLessThanOrEqual(300)
  })

  it('passes recent rejections to the ranker', async () => {
    await seedCampaign({
      status: 'REJECTED',
      title: '다이어트 쉐이크',
      rejectReason: '관심 없는 품목',
    })
    await seedCampaign({ detail: sampleDetail() })
    chatJson.mockResolvedValueOnce({ scores: [] })
    await rankDetailed()
    const call = chatJson.mock.calls[0]?.[0] as { user: string }
    expect(call.user).toContain('다이어트 쉐이크')
    expect(call.user).toContain('관심 없는 품목')
  })
})

describe('rewriteApplyMessage', () => {
  beforeEach(() => chatJson.mockReset())

  it('writes the new message and bumps the revision', async () => {
    const id = await seedCampaign({ status: 'PENDING_REVIEW', applyMessage: '원본', revision: 3 })
    chatJson.mockResolvedValueOnce({ applyMessage: '고친 문구입니다.' })
    expect(await rewriteApplyMessage(id, '더 짧게')).toBe(true)
    const row = await getCampaign(id)
    expect(row.apply_message).toBe('고친 문구입니다.')
    expect(row.revision).toBe(4)
  })

  it('loses to a concurrent edit that bumped the revision', async () => {
    const id = await seedCampaign({ status: 'PENDING_REVIEW', applyMessage: '원본', revision: 3 })
    chatJson.mockImplementationOnce(async () => {
      await query(
        "update campaigns set apply_message = '직접 수정', revision = revision + 1 where id = $1",
        [id],
      )
      return { applyMessage: '고친 문구입니다.' }
    })
    expect(await rewriteApplyMessage(id, '더 짧게')).toBe(false)
    const row = await getCampaign(id)
    expect(row.apply_message).toBe('직접 수정')
    expect(row.revision).toBe(4)
  })

  it('does nothing unless the campaign is PENDING_REVIEW', async () => {
    const id = await seedCampaign({ status: 'APPROVED', applyMessage: '원본' })
    expect(await rewriteApplyMessage(id, '더 짧게')).toBe(false)
    expect(chatJson).not.toHaveBeenCalled()
  })
})
