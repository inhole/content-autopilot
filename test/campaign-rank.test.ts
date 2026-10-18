import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../src/llm/openrouter.ts', () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }))

const { fitApplyMessage, pickTopCampaigns, remainingQuota, ruleSkipReason, truncateAtSentence } =
  await import('../src/campaigns/rank.ts')
const { parseCampaignProfile } = await import('../src/campaigns/profile.ts')

import type { CampaignDetail } from '../src/campaigns/types.ts'

const profile = parseCampaignProfile({
  blog: { url: 'https://blog.naver.com/x', topic: 't', tone: 't' },
  types: ['delivery'],
  interests: [],
  excludeKeywords: ['주류', 'Diet'],
  minRewardWon: 20000,
  applyMessage: { maxChars: 100, points: [] },
})

const now = new Date('2026-10-18T03:00:00Z')

const detail = (over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  title: '무선 이어폰',
  type: 'delivery',
  category: 'IT',
  offer: '무선 이어폰 1개',
  rewardWon: 50000,
  recruitCount: 5,
  applyDeadline: null,
  announceAt: null,
  reviewDeadline: null,
  channel: '네이버 블로그',
  keywords: [],
  guide: '사진 5장',
  applyQuestions: [],
  ...over,
})

const base = {
  type: 'delivery' as const,
  reward_won: 50000,
  apply_deadline: new Date('2026-10-25T00:00:00Z'),
  title: '무선 이어폰',
  category: 'IT',
  detail: detail(),
}

describe('ruleSkipReason', () => {
  const cases: [string, Partial<Record<keyof typeof base, unknown>>, string | null][] = [
    ['passes a fitting campaign', {}, null],
    ['visit type', { type: 'visit' as never }, '유형: 방문형'],
    ['excluded keyword in title', { title: '수제 주류 세트' }, '제외 키워드: 주류'],
    [
      'excluded keyword in offer, case-insensitive',
      { detail: detail({ offer: 'diet shake' }) },
      '제외 키워드: Diet',
    ],
    [
      'excluded keyword in guide',
      { detail: detail({ guide: '주류 인증 필요' }) },
      '제외 키워드: 주류',
    ],
    ['low reward', { reward_won: 10000 }, '제공 가치 낮음'],
    ['unknown reward passes', { reward_won: null }, null],
    ['deadline passed', { apply_deadline: new Date('2026-10-17T00:00:00Z') }, '신청 마감 지남'],
    ['no deadline passes', { apply_deadline: null }, null],
    ['non-blog channel', { detail: detail({ channel: '인스타그램' }) }, '채널: 인스타그램'],
    ['blog among channels', { detail: detail({ channel: '블로그 + 인스타그램' }) }, null],
    ['no detail passes', { detail: null }, null],
  ]
  it.each(cases)('%s', (_name, over, expected) => {
    expect(ruleSkipReason({ ...base, ...over } as typeof base, profile, now)).toBe(expected)
  })
})

describe('remainingQuota', () => {
  it('subtracts and never goes negative', () => {
    expect(remainingQuota(5, 2)).toBe(3)
    expect(remainingQuota(5, 5)).toBe(0)
    expect(remainingQuota(5, 9)).toBe(0)
  })
})

describe('pickTopCampaigns', () => {
  const s = (id: number, score: number) => ({ id, score, reason: `r${id}`, applyMessage: 'm' })
  it('takes the best known ids, ignoring unknown and repeated ones', () => {
    const out = pickTopCampaigns(
      [s(1, 5), s(2, 9), s(99, 10), s(3, 7), s(2, 1)],
      new Set([1, 2, 3]),
      2,
    )
    expect(out.picked.map((x) => x.id)).toEqual([2, 3])
    expect(out.rest.map((x) => x.id)).toEqual([1])
  })
  it('picks nothing when the quota is 0', () => {
    const out = pickTopCampaigns([s(1, 5)], new Set([1]), 0)
    expect(out.picked).toEqual([])
    expect(out.rest.map((x) => x.id)).toEqual([1])
  })
})

describe('truncateAtSentence', () => {
  it('leaves short text alone', () => {
    expect(truncateAtSentence('안녕하세요.', 50)).toBe('안녕하세요.')
  })
  it('cuts at the last sentence end within the limit', () => {
    const text = `${'가'.repeat(30)}. ${'나'.repeat(30)}. ${'다'.repeat(30)}.`
    const out = truncateAtSentence(text, 70)
    expect(out.endsWith('.')).toBe(true)
    expect([...out].length).toBeLessThanOrEqual(70)
    expect(out).toContain('나')
    expect(out).not.toContain('다')
  })
  it('hard-cuts with an ellipsis when there is no sentence end', () => {
    const out = truncateAtSentence('가'.repeat(200), 50)
    expect([...out]).toHaveLength(50)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('fitApplyMessage', () => {
  beforeEach(() => chatJson.mockReset())

  it('returns a message within the limit without an LLM call', async () => {
    expect(await fitApplyMessage('  짧은 글  ', 100)).toBe('짧은 글')
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('asks once to shorten and uses the result', async () => {
    chatJson.mockResolvedValueOnce({ text: '가'.repeat(60) })
    const out = await fitApplyMessage('가'.repeat(150), 100)
    expect(out).toBe('가'.repeat(60))
    expect(chatJson).toHaveBeenCalledOnce()
  })

  it('truncates when the shortened text is still too long', async () => {
    chatJson.mockResolvedValueOnce({ text: `${'가'.repeat(80)}. ${'나'.repeat(80)}.` })
    const out = await fitApplyMessage('가'.repeat(300), 100)
    expect([...out].length).toBeLessThanOrEqual(100)
    expect(chatJson).toHaveBeenCalledOnce()
  })

  it('truncates when shortening fails', async () => {
    chatJson.mockRejectedValueOnce(new Error('boom'))
    const out = await fitApplyMessage('가'.repeat(300), 100)
    expect([...out].length).toBeLessThanOrEqual(100)
  })

  it('counts characters, not UTF-16 units', async () => {
    const emoji = '😀'.repeat(100)
    expect(await fitApplyMessage(emoji, 100)).toBe(emoji)
  })
})
