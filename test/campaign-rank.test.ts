import { describe, expect, it } from 'vitest'
import { parseCampaignProfile } from '../src/campaigns/profile.ts'
import { candidateLine, rankSystem } from '../src/campaigns/prompts.ts'
import {
  chunk,
  pickTopCampaigns,
  remainingQuota,
  ruleScore,
  ruleSkipReason,
  toRankCandidate,
} from '../src/campaigns/rank.ts'

const profile = parseCampaignProfile({
  about: 'dev',
  interests: [],
  excludeKeywords: ['주류', 'Diet'],
  excludeBrands: ['나쁜브랜드'],
  maxCompetition: 100,
  minPriceWon: 30000,
  review: { tone: 't' },
})
const now = new Date('2026-10-18T03:00:00Z')
const base = {
  title: '무선 이어폰',
  brand: '좋은브랜드' as string | null,
  application_count: 50 as number | null,
  recruit_count: 5 as number | null,
  apply_deadline: new Date('2026-10-25T00:00:00Z') as Date | null,
  remaining_days: 6 as number | null,
}

describe('ruleSkipReason', () => {
  const cases: [string, Partial<typeof base> & Record<string, unknown>, string | null][] = [
    ['passes a fitting campaign', {}, null],
    ['keyword in title', { title: '수제 주류 세트' }, '제외 키워드: 주류'],
    ['keyword in brand, case-insensitive', { brand: 'diet lab' }, '제외 키워드: Diet'],
    ['excluded brand', { brand: '나쁜브랜드(공식)' }, '제외 브랜드: 나쁜브랜드(공식)'],
    ['too competitive', { application_count: 1000, recruit_count: 5 }, '경쟁률 200:1'],
    ['exactly at the limit passes', { application_count: 500, recruit_count: 5 }, null],
    ['unknown competition passes', { application_count: null }, null],
    ['zero recruit passes (no ratio)', { recruit_count: 0 }, null],
    ['deadline passed', { apply_deadline: new Date('2026-10-17T00:00:00Z') }, '모집 마감'],
    ['negative remaining days', { remaining_days: -1, apply_deadline: null }, '모집 마감'],
    ['no deadline info passes', { remaining_days: null, apply_deadline: null }, null],
    [
      'gift price below the minimum',
      { source: 'kakao-gift', detail: { price: { basic: 14900, selling: 9900 } } },
      '가격 낮음: 14,900원',
    ],
    [
      'gift price at the minimum passes',
      { source: 'kakao-gift', detail: { price: { basic: 30000, selling: 9900 } } },
      null,
    ],
    ['unknown gift price passes', { source: 'kakao-gift', detail: { priceTriedAt: 'x' } }, null],
    [
      'musinsa list price below the minimum',
      {
        source: 'musinsa',
        detail: {
          products: [{ isRepresentative: true, prices: { normalPrice: { value: 12000 } } }],
        },
      },
      '가격 낮음: 12,000원',
    ],
  ]
  it.each(cases)('%s', (_name, over, expected) => {
    expect(
      ruleSkipReason({ ...base, ...over } as Parameters<typeof ruleSkipReason>[0], profile, now),
    ).toBe(expected)
  })

  it('has no competition limit when maxCompetition is unset', () => {
    const open = parseCampaignProfile({
      about: 'a',
      interests: [],
      excludeKeywords: [],
      review: { tone: 't' },
    })
    expect(ruleSkipReason({ ...base, application_count: 99999 }, open, now)).toBeNull()
  })
})

describe('remainingQuota', () => {
  it('never goes negative', () => {
    expect(remainingQuota(5, 2)).toBe(3)
    expect(remainingQuota(5, 5)).toBe(0)
    expect(remainingQuota(5, 9)).toBe(0)
  })
})

describe('chunk', () => {
  it('splits into batches of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
  })
})

describe('pickTopCampaigns', () => {
  const s = (id: number, score: number) => ({ id, score, reason: `r${id}` })
  it('merges batches: top N overall, ties by id, unknown and repeated ids dropped', () => {
    const batchA = [s(1, 5), s(2, 9), s(99, 10)]
    const batchB = [s(3, 9), s(4, 7), s(2, 1)]
    const { picked, rest } = pickTopCampaigns([...batchA, ...batchB], new Set([1, 2, 3, 4]), 3)
    expect(picked.map((p) => p.id)).toEqual([2, 3, 4])
    expect(rest.map((p) => p.id)).toEqual([1])
  })
})

describe('Musinsa campaigns', () => {
  it('are never skipped for competition, only by keyword, brand or deadline', () => {
    const musinsa = { ...base, application_count: null, recruit_count: null }
    expect(ruleSkipReason(musinsa, profile, now)).toBeNull()
    expect(ruleSkipReason({ ...musinsa, title: '주류 세트' }, profile, now)).toBe(
      '제외 키워드: 주류',
    )
    expect(
      ruleSkipReason(
        { ...musinsa, apply_deadline: new Date('2026-10-17T00:00:00Z') },
        profile,
        now,
      ),
    ).toBe('모집 마감')
  })
})

describe('rank prompts per source', () => {
  const detail = {
    eventCategory: 'TOP',
    products: [
      {
        uniqueId: '7529016',
        isRepresentative: true,
        prices: { normalPrice: { value: 129000 }, salePrice: { value: 89000 } },
      },
      { uniqueId: '7529017' },
    ],
  }
  const row = (over: Record<string, unknown>) =>
    ({
      id: 5,
      source: 'musinsa',
      title: '후드 집업',
      brand: '브랜드',
      application_count: 50,
      recruit_count: 10,
      remaining_days: 3,
      detail,
      ...over,
    }) as Parameters<typeof toRankCandidate>[0]

  it('shows category, price, goods count and competition for Musinsa', () => {
    const line = candidateLine(toRankCandidate(row({})))
    expect(line).toContain('[5] 후드 집업')
    expect(line).toContain('품목 상의')
    expect(line).toContain('정가 129,000원 (할인가 89,000원)')
    expect(line).toContain('상품 2개')
    expect(line).toContain('모집 10명 / 신청 50명 (경쟁률 5.0:1)')
    expect(line).toContain('남은 기간 3일')
    expect(line).not.toContain('리뷰 형식')
  })
  it('leaves out what Musinsa did not give', () => {
    const line = candidateLine(
      toRankCandidate(row({ detail: null, application_count: null, recruit_count: null })),
    )
    expect(line).not.toMatch(/정가|상품 \d|경쟁률|품목/)
  })
  it('keeps competition for gift campaigns', () => {
    const line = candidateLine(
      toRankCandidate(
        row({ source: 'kakao-gift', detail: null, application_count: 50, recruit_count: 10 }),
      ),
    )
    expect(line).toContain('모집 10명 / 신청 50명 (경쟁률 5.0:1)')
    expect(line).not.toContain('정가')
  })
  it('shows the gift price once it is known', () => {
    const line = candidateLine(
      toRankCandidate(
        row({
          source: 'kakao-gift',
          detail: { price: { basic: 49000, selling: 39200 } } as never,
        }),
      ),
    )
    expect(line).toContain('정가 49,000원 (할인가 39,200원)')
  })
  it('both prompts ask for pricier products to score higher', () => {
    for (const s of ['kakao-gift', 'musinsa']) {
      expect(rankSystem(s)).toContain('정가가 높은 제품')
    }
  })
  it('system prompts name the shop and the competition rule', () => {
    expect(rankSystem('musinsa')).toContain('무신사')
    expect(rankSystem('musinsa')).toContain('경쟁률(신청자 수 / 모집 인원)')
    expect(rankSystem('musinsa')).toContain('정가')
    expect(rankSystem('kakao-gift')).not.toContain('소모성')
    expect(rankSystem('kakao-gift')).toContain('선물하기')
    expect(rankSystem('kakao-gift')).toContain('경쟁률(신청자 수 / 모집 인원)')
  })
})

describe('ruleScore', () => {
  const liking = parseCampaignProfile({
    about: 'dev',
    interests: ['주방용품'],
    preferKeywords: ['키보드'],
    excludeKeywords: [],
    review: { tone: 't' },
  })
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 1,
      source: 'kakao-gift',
      title: '무선 이어폰',
      brand: '브랜드',
      application_count: 50,
      recruit_count: 5,
      detail: { price: { basic: 49000, selling: 39000 } },
      ...over,
    }) as Parameters<typeof ruleScore>[0]
  const score = (over: Record<string, unknown> = {}) => ruleScore(row(over), liking).score

  it('explains competition and price in the reason', () => {
    expect(ruleScore(row(), liking)).toEqual({
      id: 1,
      score: expect.any(Number),
      reason: '경쟁률 10:1 · 정가 49,000원',
    })
  })
  it('ranks lower competition, a higher price and a preferred word higher', () => {
    expect(score({ application_count: 5 })).toBeGreaterThan(score())
    expect(score({ detail: { price: { basic: 200000 } } })).toBeGreaterThan(score())
    expect(score({ title: '기계식 키보드' })).toBeCloseTo(score() + 2, 1)
    expect(ruleScore(row({ title: '기계식 키보드' }), liking).reason).toContain('관심 키보드')
  })
  it('stays within 0 to 10', () => {
    const best = { application_count: 1, detail: { price: { basic: 900000 } }, title: '키보드' }
    expect(score(best)).toBe(10)
    expect(score({ application_count: 99999, detail: { price: { basic: 1000 } } })).toBe(0)
  })
  it('gives unknown competition and price part of their points', () => {
    const unknown = ruleScore(row({ application_count: null, detail: null }), liking)
    expect(unknown.reason).toBe('경쟁률 모름 · 정가 모름')
    expect(unknown.score).toBe(3.5)
  })
  it('matches preferences against the Musinsa category label', () => {
    const musinsa = ruleScore(
      row({
        source: 'musinsa',
        title: '무선 충전 패드',
        detail: { eventCategory: 'DIGITAL_LIFE' },
      }),
      parseCampaignProfile({
        about: 'a',
        interests: ['디지털'],
        excludeKeywords: [],
        review: { tone: 't' },
      }),
    )
    expect(musinsa.reason).toBe('경쟁률 10:1 · 정가 모름 · 관심 디지털')
  })
})
