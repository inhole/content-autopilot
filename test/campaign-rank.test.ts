import { describe, expect, it } from 'vitest'
import { parseCampaignProfile } from '../src/campaigns/profile.ts'
import { chunk, pickTopCampaigns, remainingQuota, ruleSkipReason } from '../src/campaigns/rank.ts'

const profile = parseCampaignProfile({
  about: 'dev',
  interests: [],
  excludeKeywords: ['주류', 'Diet'],
  excludeBrands: ['나쁜브랜드'],
  maxCompetition: 100,
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
  const cases: [string, Partial<typeof base>, string | null][] = [
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
  ]
  it.each(cases)('%s', (_name, over, expected) => {
    expect(ruleSkipReason({ ...base, ...over }, profile, now)).toBe(expected)
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
