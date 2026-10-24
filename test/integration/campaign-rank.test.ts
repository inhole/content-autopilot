import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

// A fixed profile, so the rule cases do not depend on config/campaign-profile.json.
vi.mock('../../src/campaigns/profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/campaigns/profile.ts')>()
  const profile = actual.parseCampaignProfile({
    about: '테스트 프로필',
    interests: ['생활용품'],
    excludeKeywords: ['다이어트 보조제', '주류'],
    maxCompetition: 1000,
    review: { tone: '담백하게' },
  })
  return { ...actual, loadCampaignProfile: async () => profile }
})

const { config } = await import('../../src/config.ts')
const { query } = await import('../../src/db/pool.ts')
const { rankCollected } = await import('../../src/campaigns/rank.ts')
const { getCampaign, seedCampaign } = await import('./campaign-helpers-rank.ts')

const score = (id: number, s: number) => ({ id, score: s, reason: `이유 ${id}` })
const now = new Date()

describe('rankCollected by rule', () => {
  beforeEach(() => {
    chatJson.mockReset()
    config.CAMPAIGN_DAILY_MAX = 2
    config.CAMPAIGN_RANK_MODE = 'rule'
  })

  it('scores every candidate in code, shortlists the top N and skips the rest', async () => {
    const crowded = await seedCampaign({ applicationCount: 900, recruitCount: 10 })
    const easy = await seedCampaign({ applicationCount: 20, recruitCount: 10 })
    const liked = await seedCampaign({ title: '생활용품 세트', applicationCount: 300 })
    const keyword = await seedCampaign({ title: '주류 세트' })

    // 2:1 beats 30:1 on competition, but the interest hit puts `liked` first.
    expect(await rankCollected(now)).toEqual([liked, easy])

    expect(chatJson).not.toHaveBeenCalled()
    const rowEasy = await getCampaign(easy)
    expect(rowEasy.status).toBe('SHORTLISTED')
    expect(rowEasy.reason).toBe('경쟁률 2.0:1 · 정가 모름')
    expect((await getCampaign(liked)).reason).toContain('관심 생활용품')
    expect(await getCampaign(crowded)).toMatchObject({
      status: 'SKIPPED',
      skip_reason: '선별 탈락: 경쟁률 90:1 · 정가 모름',
    })
    expect((await getCampaign(keyword)).skip_reason).toBe('제외 키워드: 주류')
  })
})

describe('rankCollected by LLM', () => {
  beforeEach(() => {
    chatJson.mockReset()
    config.CAMPAIGN_DAILY_MAX = 2
    config.CAMPAIGN_RANK_MODE = 'llm'
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

  it('keeps gift campaigns whose price was not tried yet COLLECTED', async () => {
    const waiting = await seedCampaign({ productId: 101 })
    const priced = await seedCampaign({
      productId: 102,
      detail: { price: { basic: 50000, selling: 45000 } },
    })
    const failed = await seedCampaign({
      productId: 103,
      detail: { priceTriedAt: now.toISOString() },
    })
    const noProduct = await seedCampaign()
    chatJson.mockResolvedValueOnce({
      scores: [score(priced, 9), score(failed, 8), score(noProduct, 1)],
    })

    const shortlisted = await rankCollected(now)

    expect(shortlisted).toEqual([priced, failed])
    expect((await getCampaign(waiting)).status).toBe('COLLECTED')
    expect((await getCampaign(noProduct)).status).toBe('SKIPPED')
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

  it('does not count campaigns that expired today without ever being picked', async () => {
    // Hourly maintenance expires unpicked COLLECTED rows and bumps their updated_at.
    await seedCampaign({ status: 'EXPIRED' })
    await seedCampaign({ status: 'EXPIRED' })
    await seedCampaign({ status: 'SKIPPED' })
    const a = await seedCampaign()
    const b = await seedCampaign()
    chatJson.mockResolvedValueOnce({ scores: [score(a, 5), score(b, 8)] })

    expect(await rankCollected(now)).toEqual([b, a])
    const [row] = await query<{ shortlisted_at: Date | null }>(
      'select shortlisted_at from campaigns where id = $1',
      [b],
    )
    expect(row?.shortlisted_at).toBeInstanceOf(Date)
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

  it('ranks each source on its own with its own daily quota and prompt', async () => {
    config.CAMPAIGN_DAILY_MAX = 1
    // Gift already used its quota today; Musinsa has not.
    await seedCampaign({ status: 'SHORTLISTED' })
    const gift = await seedCampaign()
    const detail = (eventCategory: string) => ({
      eventCategory,
      products: [
        { uniqueId: '1', isRepresentative: true, prices: { normalPrice: { value: 59000 } } },
      ],
    })
    const m1 = await seedCampaign({
      source: 'musinsa',
      recruitCount: null,
      applicationCount: null,
      detail: detail('TOP'),
    })
    const m2 = await seedCampaign({
      source: 'musinsa',
      recruitCount: null,
      applicationCount: null,
      detail: detail('SHOE'),
    })
    chatJson.mockResolvedValueOnce({ scores: [score(m1, 4), score(m2, 8)] })

    const shortlisted = await rankCollected(now)

    expect(shortlisted).toEqual([m2])
    expect(chatJson).toHaveBeenCalledTimes(1)
    const call = chatJson.mock.calls[0]?.[0] as { system: string; user: string }
    expect(call.system).toContain('무신사')
    expect(call.user).toContain('정가 59,000원')
    expect(call.user).toContain('품목 상의')
    expect(call.user).toContain('품목 신발')
    expect(call.user).not.toContain('경쟁률')
    expect((await getCampaign(gift)).status).toBe('COLLECTED')
    expect((await getCampaign(m1)).status).toBe('SKIPPED')
    expect((await getCampaign(m2)).status).toBe('SHORTLISTED')
  })

  it('shortlists up to the quota in every source and concatenates the results', async () => {
    config.CAMPAIGN_DAILY_MAX = 1
    const g1 = await seedCampaign()
    const g2 = await seedCampaign()
    const m1 = await seedCampaign({ source: 'musinsa', recruitCount: null, applicationCount: null })
    chatJson
      .mockResolvedValueOnce({ scores: [score(g1, 3), score(g2, 9)] })
      .mockResolvedValueOnce({ scores: [score(m1, 5)] })

    expect(await rankCollected(now)).toEqual([g2, m1])
    expect(chatJson).toHaveBeenCalledTimes(2)
    const systems = chatJson.mock.calls.map((c) => (c[0] as { system: string }).system)
    expect(systems[0]).toContain('선물하기')
    expect(systems[1]).toContain('무신사')
  })
})
