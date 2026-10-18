import { describe, expect, it } from 'vitest'
import { dueReminders, type ReminderInput } from '../src/campaigns/reminders.ts'

const TZ = 'Asia/Seoul'

function c(over: Partial<ReminderInput> = {}): ReminderInput {
  return {
    id: 7,
    status: 'SELECTED',
    title: '무선 이어폰',
    apply_deadline: new Date('2026-10-10T14:59:00Z'),
    selected_at: new Date('2026-10-20T00:00:00Z'),
    review_deadline: null,
    ...over,
  }
}
const kinds = (input: ReminderInput, sent: string[], now: string) =>
  dueReminders(input, new Set(sent), new Date(now), TZ).map((r) => r.kind)

describe('result-check', () => {
  const applied = c({ status: 'APPLIED', selected_at: null })
  it('waits a day after the apply deadline', () => {
    expect(kinds(applied, [], '2026-10-11T14:58:00Z')).toEqual([])
    expect(kinds(applied, [], '2026-10-11T14:59:00Z')).toEqual(['result-check'])
  })
  it('has sel/unsel buttons with revision 0 and goes out once', () => {
    const [r] = dueReminders(applied, new Set(), new Date('2026-10-15T00:00:00Z'), TZ)
    expect(r?.buttons.map((b) => ('callback' in b ? b.callback.action : 'url'))).toEqual([
      'sel',
      'unsel',
    ])
    expect(kinds(applied, ['result-check'], '2026-10-15T00:00:00Z')).toEqual([])
  })
  it('needs an apply deadline', () => {
    expect(kinds({ ...applied, apply_deadline: null }, [], '2026-12-01T00:00:00Z')).toEqual([])
  })
})

describe('due-missing', () => {
  it('asks for /due one day after selection while no deadline is known', () => {
    expect(kinds(c(), [], '2026-10-20T23:59:00Z')).toEqual([])
    const [r] = dueReminders(c(), new Set(), new Date('2026-10-21T00:00:00Z'), TZ)
    expect(r?.kind).toBe('due-missing')
    expect(r?.text).toContain('/due 7')
  })
  it('stops once the deadline is set or it was sent', () => {
    expect(kinds(c(), ['due-missing'], '2026-10-25T00:00:00Z')).toEqual([])
    expect(
      kinds(c({ review_deadline: new Date('2026-12-30T14:59:00Z') }), [], '2026-10-25T00:00:00Z'),
    ).toEqual([])
  })
})

describe('review deadline reminders', () => {
  // Deadline 10/30 23:59 KST.
  const input = c({ review_deadline: new Date('2026-10-30T14:59:00Z'), selected_at: null })
  const at = (iso: string, sent: string[] = [], over: Partial<ReminderInput> = {}) =>
    kinds({ ...input, ...over }, sent, iso)

  it('picks the kind by KST calendar day, across midnight', () => {
    expect(at('2026-10-26T14:59:00Z')).toEqual([]) // 10/26 23:59 KST: 4 days left
    expect(at('2026-10-26T15:00:00Z')).toEqual(['review-d3']) // 10/27 00:00 KST
    expect(at('2026-10-27T15:00:00Z')).toEqual(['review-d3']) // 10/28 00:00 KST: 2 days
    expect(at('2026-10-28T14:59:00Z')).toEqual(['review-d3']) // 10/28 23:59 KST
    expect(at('2026-10-28T15:00:00Z')).toEqual(['review-d1']) // 10/29 00:00 KST
    expect(at('2026-10-29T15:00:00Z')).toEqual(['review-d0']) // 10/30 00:00 KST
  })
  it('only sends the most specific kind not yet sent', () => {
    expect(at('2026-10-29T15:00:00Z', ['review-d3'])).toEqual(['review-d0'])
    expect(at('2026-10-29T15:00:00Z', ['review-d0'])).toEqual([])
    // Selected a day before the deadline: no stale "3 days left" after d1 went out.
    expect(at('2026-10-27T15:00:00Z', ['review-d1'])).toEqual([])
    expect(at('2026-10-28T15:00:00Z', ['review-d0'])).toEqual([])
  })
  it('fires d0 for an overdue deadline too', () => {
    expect(at('2026-11-02T00:00:00Z')).toEqual(['review-d0'])
  })
  it('adds the draft button only while SELECTED', () => {
    const now = new Date('2026-10-29T15:00:00Z')
    const sel = dueReminders(input, new Set(), now, TZ)[0]
    expect(sel?.buttons).toEqual([
      {
        text: '📝 리뷰 초안 쓰기',
        callback: { ns: 'rev', action: 'draft', campaignId: 7, revision: 0 },
      },
    ])
    const draft = dueReminders({ ...input, status: 'DRAFT_REVIEW' }, new Set(), now, TZ)[0]
    expect(draft?.kind).toBe('review-d0')
    expect(draft?.buttons).toEqual([])
  })
  it('ignores other statuses', () => {
    expect(at('2026-10-29T15:00:00Z', [], { status: 'POSTED' })).toEqual([])
    expect(at('2026-10-29T15:00:00Z', [], { status: 'APPLIED' })).not.toContain('review-d0')
  })
})

describe('source label', () => {
  it('names the source in the reminder text', () => {
    const [gift] = dueReminders(
      c({ status: 'APPLIED', selected_at: null }),
      new Set(),
      new Date('2026-10-15T00:00:00Z'),
      TZ,
    )
    expect(gift?.text).toContain('[선물하기]')
    expect(gift?.text).toContain('카카오톡')
    const [musinsa] = dueReminders(
      c({ source: 'musinsa', status: 'APPLIED', selected_at: null }),
      new Set(),
      new Date('2026-10-15T00:00:00Z'),
      TZ,
    )
    expect(musinsa?.text).toContain('[무신사]')
    expect(musinsa?.text).toContain('무신사에서 확인')
  })
})
