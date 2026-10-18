import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.hoisted(() => vi.fn())
vi.mock('../src/llm/openrouter.ts', () => ({ chatJson }))

import { parseCampaignProfile } from '../src/campaigns/profile.ts'
import {
  chars,
  composeReview,
  cutAtSentence,
  draftBody,
  reviewLimits,
} from '../src/campaigns/review-draft.ts'
import { reviewSystem, reviewUser } from '../src/campaigns/review-prompts.ts'

const DISCLOSURE = '체험단으로 제품을 제공받아 작성한 솔직한 리뷰입니다.'

const profile = (over: Record<string, unknown> = {}) =>
  parseCampaignProfile({
    about: 'IT 개발자',
    interests: [],
    excludeKeywords: [],
    review: { tone: '담백하게', minChars: 100, maxChars: 500, points: ['좋았던 점'] },
    ...over,
  })

describe('composeReview', () => {
  it('returns the trimmed body when no disclosure is set', () => {
    expect(composeReview(profile(), '  좋았어요  ')).toBe('좋았어요')
  })
  it('puts the disclosure first', () => {
    expect(composeReview(profile({ disclosure: DISCLOSURE }), '좋았어요')).toBe(
      `${DISCLOSURE}\n\n좋았어요`,
    )
  })
  it('strips an identical disclosure line the model added', () => {
    const out = composeReview(profile({ disclosure: DISCLOSURE }), `${DISCLOSURE}\n\n좋았어요`)
    expect(out).toBe(`${DISCLOSURE}\n\n좋았어요`)
  })
  it('strips a differently worded sponsorship first line', () => {
    const out = composeReview(
      profile({ disclosure: DISCLOSURE }),
      '[협찬] 소정의 상품을 제공받았습니다.\n좋았어요',
    )
    expect(out).toBe(`${DISCLOSURE}\n\n좋았어요`)
  })
  it('keeps an ordinary first line', () => {
    const out = composeReview(profile({ disclosure: DISCLOSURE }), '일주일 썼어요\n좋았어요')
    expect(out).toBe(`${DISCLOSURE}\n\n일주일 썼어요\n좋았어요`)
  })
})

describe('reviewLimits', () => {
  it('uses the profile limits without a disclosure', () => {
    expect(reviewLimits(profile())).toEqual({ min: 100, max: 500 })
  })
  it('reserves room for the disclosure line', () => {
    const reserve = chars(DISCLOSURE) + 2
    expect(reviewLimits(profile({ disclosure: DISCLOSURE }))).toEqual({
      min: 100 - reserve > 1 ? 100 - reserve : 1,
      max: 500 - reserve,
    })
  })
  it('keeps min within max', () => {
    const l = reviewLimits(profile({ review: { tone: 't', minChars: 400, maxChars: 60 } }))
    expect(l.min).toBeLessThanOrEqual(l.max)
  })
})

describe('cutAtSentence', () => {
  it('leaves short text alone', () => {
    expect(cutAtSentence('짧아요.', 20)).toBe('짧아요.')
  })
  it('cuts at the last sentence end within the limit', () => {
    const text = '첫 문장입니다. 두 번째 문장입니다. 세 번째 문장이 아주 길게 이어집니다'
    const out = cutAtSentence(text, 25)
    expect(chars(out)).toBeLessThanOrEqual(25)
    expect(out.endsWith('.')).toBe(true)
  })
  it('hard cuts when there is no sentence end', () => {
    expect(chars(cutAtSentence('가'.repeat(100), 30))).toBe(30)
  })
})

describe('draftBody length enforcement', () => {
  const limits = { min: 20, max: 40 }
  beforeEach(() => chatJson.mockReset())

  it('returns an in-range body with one call', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(30) })
    expect(await draftBody('s', 'u', 'memo', limits)).toBe('가'.repeat(30))
    expect(chatJson).toHaveBeenCalledTimes(1)
  })
  it('asks once to shorten an over-long body', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(80) })
    chatJson.mockResolvedValueOnce({ text: '나'.repeat(35) })
    expect(await draftBody('s', 'u', 'memo', limits)).toBe('나'.repeat(35))
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(chatJson.mock.calls[1]?.[0].user).toContain('줄여줘')
  })
  it('cuts when the shortened body is still over the max', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(80) })
    chatJson.mockResolvedValueOnce({ text: '나'.repeat(70) })
    const out = await draftBody('s', 'u', 'memo', limits)
    expect(chars(out)).toBeLessThanOrEqual(40)
    expect(chatJson).toHaveBeenCalledTimes(2)
  })
  it('asks once to expand a short body, with the memo', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(5) })
    chatJson.mockResolvedValueOnce({ text: '나'.repeat(25) })
    expect(await draftBody('s', 'u', '메모 내용', limits)).toBe('나'.repeat(25))
    expect(chatJson.mock.calls[1]?.[0].user).toContain('메모 내용')
  })
  it('keeps the short body when the expansion is no better', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(5) })
    chatJson.mockResolvedValueOnce({ text: '나'.repeat(90) })
    expect(await draftBody('s', 'u', 'memo', limits)).toBe('가'.repeat(5))
    expect(chatJson).toHaveBeenCalledTimes(2)
  })
})

describe('prompts', () => {
  it('ground the draft in the memo and carry the limits', () => {
    const sys = reviewSystem(profile(), { min: 100, max: 500 })
    expect(sys).toContain('지어내지 마')
    expect(sys).toContain('100자 이상 500자 이하')
    expect(sys).toContain('좋았던 점')
    const user = reviewUser({ title: '이어폰', brand: '브랜드', memo: '일주일 썼음' })
    expect(user).toContain('일주일 썼음')
    expect(user).not.toContain('수정 요청')
  })
  it('adds the previous draft and the feedback', () => {
    const user = reviewUser(
      { title: '이어폰', brand: null, memo: '메모' },
      { feedback: '더 짧게', previous: '이전 글' },
    )
    expect(user).toContain('이전 글')
    expect(user).toContain('더 짧게')
  })
})
