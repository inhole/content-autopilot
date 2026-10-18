import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

const { config } = await import('../../src/config.ts')
const { rankCollected } = await import('../../src/campaigns/rank.ts')
const { getCampaign, seedCampaign } = await import('./campaign-helpers-rank.ts')

const score = (id: number, s: number) => ({ id, score: s, reason: `이유 ${id}` })
const now = new Date()

describe('rankCollected', () => {
  beforeEach(() => {
    chatJson.mockReset()
    config.CAMPAIGN_DAILY_MAX = 2
  })

  it('skips by rule, shortlists the top N and skips the rest', async () => {
    const keyword = await seedCampaign({ title: '다이어트 보조제 체험' })
    const hot = await seedCampaign({ applicationCount: 99999, recruitCount: 1 })
    const closed = await seedCampaign({ remainingDays: -1 })
    const a = await seedCampaign()
    const b = await seedCampaign()
    const c = await seedCampaign()
    chatJson.mockResolvedValueOnce({
      scores: [score(a, 6), score(b, 9), score(c, 3), score(999, 10)],
    })

    const shortlisted = await rankCollected(now)

    expect(shortlisted).toEqual([b, a])
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(chatJson.mock.calls[0]?.[0]).toMatchObject({ temperature: 0.3 })
    expect(await getCampaign(keyword)).toMatchObject({
      status: 'SKIPPED',
      skip_reason: '제외 키워드: 다이어트 보조제',
    })
    expect((await getCampaign(hot)).skip_reason).toMatch(/^경쟁률 /)
    expect((await getCampaign(closed)).skip_reason).toBe('모집 마감')
    const rowB = await getCampaign(b)
    expect(rowB.status).toBe('SHORTLISTED')
    expect(Number(rowB.score)).toBe(9)
    expect(rowB.reason).toBe(`이유 ${b}`)
    expect(await getCampaign(c)).toMatchObject({
      status: 'SKIPPED',
      skip_reason: `선별 탈락: 이유 ${c}`,
    })
  })

  it('counts campaigns shortlisted today against the quota', async () => {
    await seedCampaign({ status: 'SHORTLISTED' })
    // Older rows do not count.
    await seedCampaign({
      status: 'PENDING_REVIEW',
      updatedAt: new Date(Date.now() - 3 * 86400_000),
    })
    const a = await seedCampaign()
    const b = await seedCampaign()
    chatJson.mockResolvedValueOnce({ scores: [score(a, 5), score(b, 8)] })

    const shortlisted = await rankCollected(now)

    expect(shortlisted).toEqual([b])
    expect((await getCampaign(a)).status).toBe('SKIPPED')
  })

  it('makes no LLM call and keeps candidates COLLECTED when the quota is used up', async () => {
    await seedCampaign({ status: 'SHORTLISTED' })
    await seedCampaign({ status: 'APPLIED' })
    const a = await seedCampaign()
    const bad = await seedCampaign({ title: '주류 세트' })

    expect(await rankCollected(now)).toEqual([])
    expect(chatJson).not.toHaveBeenCalled()
    expect((await getCampaign(a)).status).toBe('COLLECTED')
    expect((await getCampaign(bad)).status).toBe('SKIPPED') // rules still apply
  })

  it('scores in batches of 60 and picks the top overall; omitted ids stay COLLECTED', async () => {
    const ids: number[] = []
    for (let i = 0; i < 130; i++) ids.push(await seedCampaign())
    chatJson.mockImplementation(async (opts: { user: string }) => {
      const batchIds = [...opts.user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
      // The model omits the first id of every batch.
      return { scores: batchIds.slice(1).map((id) => score(id, id === ids[100] ? 10 : 1)) }
    })

    const shortlisted = await rankCollected(now)

    expect(chatJson).toHaveBeenCalledTimes(3)
    const sizes = chatJson.mock.calls.map(
      (c) => [...(c[0] as { user: string }).user.matchAll(/^\[\d+\]/gm)].length,
    )
    expect(sizes).toEqual([60, 60, 10])
    expect(shortlisted[0]).toBe(ids[100])
    expect(shortlisted).toHaveLength(2)
    expect((await getCampaign(ids[0] as number)).status).toBe('COLLECTED')
    expect((await getCampaign(ids[60] as number)).status).toBe('COLLECTED')
    expect((await getCampaign(ids[120] as number)).status).toBe('COLLECTED')
    expect((await getCampaign(ids[5] as number)).status).toBe('SKIPPED')
  })

  it('puts recent owner history in the prompt', async () => {
    await seedCampaign({ status: 'APPLIED', title: '신청했던 제품' })
    await seedCampaign({
      status: 'REJECTED',
      title: '거절했던 제품',
      rejectReason: '관심 없는 품목',
    })
    config.CAMPAIGN_DAILY_MAX = 5
    const a = await seedCampaign()
    chatJson.mockResolvedValueOnce({ scores: [score(a, 7)] })

    await rankCollected(now)

    const user = String((chatJson.mock.calls[0]?.[0] as { user?: string } | undefined)?.user)
    expect(user).toContain('신청했던 제품')
    expect(user).toContain('거절했던 제품: 관심 없는 품목')
  })

  it('does not overwrite a row that left COLLECTED while the LLM ran', async () => {
    const a = await seedCampaign()
    const { query } = await import('../../src/db/pool.ts')
    chatJson.mockImplementationOnce(async () => {
      await query("update campaigns set status = 'EXPIRED' where id = $1", [a])
      return { scores: [score(a, 9)] }
    })

    expect(await rankCollected(now)).toEqual([])
    expect((await getCampaign(a)).status).toBe('EXPIRED')
  })
})
