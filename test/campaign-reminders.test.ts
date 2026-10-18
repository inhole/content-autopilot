import { describe, expect, it } from 'vitest'
import {
  calendarDaysBetween,
  dueReminders,
  type ReminderInput,
} from '../src/campaigns/reminders.ts'

const TZ = 'Asia/Seoul'
const at = (kstDate: string, kstTime = '12:00') => new Date(`${kstDate}T${kstTime}:00+09:00`)

function camp(over: Partial<ReminderInput> = {}): ReminderInput {
  return {
    id: 7,
    status: 'RECEIVED',
    title: '무선 이어폰',
    review_deadline: at('2026-10-20', '23:59'),
    selected_at: at('2026-10-01'),
    received_at: at('2026-10-05'),
    ...over,
  }
}
const kinds = (c: ReminderInput, sent: string[], now: Date) =>
  dueReminders(c, new Set(sent), now, TZ).map((r) => r.kind)

describe('calendarDaysBetween', () => {
  it('counts KST calendar days, not 24h spans', () => {
    expect(calendarDaysBetween(at('2026-10-19', '23:59'), at('2026-10-20', '00:01'), TZ)).toBe(1)
    expect(calendarDaysBetween(at('2026-10-20', '00:00'), at('2026-10-20', '23:59'), TZ)).toBe(0)
  })
})

describe('dueReminders: review deadline', () => {
  it('sends the most specific kind for the day', () => {
    expect(kinds(camp(), [], at('2026-10-17'))).toEqual(['review-d3'])
    expect(kinds(camp(), [], at('2026-10-18'))).toEqual(['review-d3'])
    expect(kinds(camp(), [], at('2026-10-19'))).toEqual(['review-d1'])
    expect(kinds(camp(), [], at('2026-10-20'))).toEqual(['review-d0'])
  })

  it('sends nothing too early or after the day', () => {
    expect(kinds(camp(), [], at('2026-10-16'))).toEqual([])
    expect(kinds(camp(), [], at('2026-10-21'))).toEqual([])
  })

  it('skips d3 when already at d1, and never goes back to an older kind', () => {
    expect(kinds(camp(), [], at('2026-10-19'))).toEqual(['review-d1'])
    expect(kinds(camp(), ['review-d1'], at('2026-10-19'))).toEqual([])
    expect(kinds(camp(), ['review-d0'], at('2026-10-20'))).toEqual([])
    expect(kinds(camp(), ['review-d3'], at('2026-10-19'))).toEqual(['review-d1'])
  })

  it('handles the KST midnight edge', () => {
    expect(kinds(camp(), [], at('2026-10-19', '23:59'))).toEqual(['review-d1'])
    expect(kinds(camp(), [], at('2026-10-20', '00:00'))).toEqual(['review-d0'])
    // 15:00Z is exactly 00:00 KST of the next day.
    expect(kinds(camp(), [], new Date('2026-10-19T15:00:00Z'))).toEqual(['review-d0'])
    expect(kinds(camp(), [], new Date('2026-10-19T14:59:00Z'))).toEqual(['review-d1'])
  })

  it('only applies to statuses that still owe the review', () => {
    for (const status of ['POSTED', 'APPLIED', 'NOT_SELECTED', 'EXPIRED'] as const) {
      expect(kinds(camp({ status }), [], at('2026-10-20'))).toEqual([])
    }
    for (const status of ['DRAFT_REVIEW', 'DRAFT_SAVED', 'DRAFT_FAILED'] as const) {
      expect(kinds(camp({ status }), [], at('2026-10-20'))).toEqual(['review-d0'])
    }
  })

  it('does nothing without a deadline', () => {
    expect(kinds(camp({ review_deadline: null }), [], at('2026-10-20'))).toEqual([])
  })
})

describe('dueReminders: selected and received-check', () => {
  const selected = (over: Partial<ReminderInput> = {}) =>
    camp({ status: 'SELECTED', received_at: null, selected_at: at('2026-10-10'), ...over })

  it('congratulates once right after selection with deadline, keywords and guide', () => {
    const c = selected({
      keywords: ['이어폰', '가성비'],
      detail: { guide: '사진 5장 이상' } as ReminderInput['detail'],
    })
    const [r] = dueReminders(c, new Set(), at('2026-10-10'), TZ)
    expect(r?.kind).toBe('selected')
    expect(r?.text).toContain('선정')
    expect(r?.text).toContain('이어폰, 가성비')
    expect(r?.text).toContain('사진 5장 이상')
    expect(r?.text).toContain('10월 20일')
    expect(r?.buttons.map((b) => b.callback)).toEqual([
      { ns: 'blog', action: 'draft', campaignId: 7, revision: 0 },
    ])
    expect(kinds(c, ['selected'], at('2026-10-10'))).toEqual([])
  })

  it('asks whether the product arrived after 3 days, with received and draft buttons', () => {
    const c = selected()
    expect(kinds(c, ['selected'], at('2026-10-13', '11:59'))).toEqual([])
    const [r] = dueReminders(c, new Set(['selected']), at('2026-10-13', '12:00'), TZ)
    expect(r?.kind).toBe('received-check')
    expect(r?.text).toContain('받으셨나요')
    expect(r?.buttons.map((b) => `${b.callback.ns}:${b.callback.action}`)).toEqual([
      'blog:received',
      'blog:draft',
    ])
  })

  it('does not ask once the product is received or the check was sent', () => {
    const received = selected({ received_at: at('2026-10-11') })
    expect(kinds(received, ['selected'], at('2026-10-14'))).toEqual([])
    expect(kinds(selected(), ['selected', 'received-check'], at('2026-10-14'))).toEqual([])
  })

  it('can send selected and a deadline reminder together', () => {
    const c = selected({ review_deadline: at('2026-10-11', '23:00') })
    expect(kinds(c, [], at('2026-10-10'))).toEqual(['selected', 'review-d1'])
  })
})
