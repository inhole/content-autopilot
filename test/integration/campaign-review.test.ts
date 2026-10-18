import { describe, expect, it } from 'vitest'
import { runCampaignReminders } from '../../src/campaigns/reminders.ts'
import {
  expireCampaigns,
  loadActiveCampaigns,
  markApplied,
  markCardSent,
  markResult,
  rejectCampaign,
  setReviewDeadline,
} from '../../src/campaigns/review.ts'
import { query } from '../../src/db/pool.ts'
import { getCampaign, seedCampaign, seedCardCampaign } from './campaign-helpers-review.ts'

describe('markCardSent', () => {
  it('moves SHORTLISTED to PENDING_REVIEW and records the card', async () => {
    const id = await seedCampaign({ status: 'SHORTLISTED' })
    expect(await markCardSent(id, 7, 55, 0)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('PENDING_REVIEW')
    expect([c.review_chat_id, c.review_message_id, c.review_revision]).toEqual([7, 55, 0])
  })
  it('re-registers a newer card for a PENDING_REVIEW campaign', async () => {
    const id = await seedCardCampaign()
    expect(await markCardSent(id, 1, 101, 0)).toBe(true)
    expect((await getCampaign(id)).review_message_id).toBe(101)
  })
  it('refuses when the revision moved while sending', async () => {
    const id = await seedCardCampaign({ revision: 2, review_revision: 1 })
    expect(await markCardSent(id, 1, 101, 1)).toBe(false)
    expect((await getCampaign(id)).review_message_id).toBe(100)
  })
  it('does not touch other statuses', async () => {
    const id = await seedCampaign({ status: 'REJECTED' })
    expect(await markCardSent(id, 1, 5, 0)).toBe(false)
    expect((await getCampaign(id)).status).toBe('REJECTED')
  })
})

describe('owner decisions on the card', () => {
  it('markApplied sets APPLIED and applied_at', async () => {
    const id = await seedCardCampaign()
    expect(await markApplied(id, 0)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('APPLIED')
    expect(c.applied_at).not.toBeNull()
  })
  it('markApplied refuses a stale revision or a second press', async () => {
    const stale = await seedCardCampaign({ revision: 1, review_revision: 0 })
    expect(await markApplied(stale, 0)).toBe(false)
    expect(await markApplied(stale, 1)).toBe(false)
    expect((await getCampaign(stale)).status).toBe('PENDING_REVIEW')

    const id = await seedCardCampaign({ revision: 1, review_revision: 1 })
    expect(await markApplied(id, 1)).toBe(true)
    expect(await markApplied(id, 1)).toBe(false)
  })
  it('rejectCampaign stores the reason and respects the revision', async () => {
    const id = await seedCardCampaign({ revision: 1, review_revision: 1 })
    expect(await rejectCampaign(id, 0, 'brand')).toBe(false)
    expect(await rejectCampaign(id, 1, 'brand')).toBe(true)
    const c = await getCampaign(id)
    expect([c.status, c.reject_reason]).toEqual(['REJECTED', 'brand'])
    expect(await rejectCampaign(id, 1, 'other')).toBe(false)
  })
})

describe('markResult', () => {
  it('APPLIED to SELECTED sets selected_at and result_at', async () => {
    const id = await seedCampaign({ status: 'APPLIED' })
    expect(await markResult(id, true)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('SELECTED')
    expect(c.selected_at).not.toBeNull()
    expect(c.result_at).not.toBeNull()
  })
  it('APPLIED to NOT_SELECTED leaves selected_at empty', async () => {
    const id = await seedCampaign({ status: 'APPLIED' })
    expect(await markResult(id, false)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('NOT_SELECTED')
    expect(c.selected_at).toBeNull()
    expect(c.result_at).not.toBeNull()
  })
  it('applies once and only to APPLIED rows', async () => {
    const id = await seedCampaign({ status: 'APPLIED' })
    expect(await markResult(id, true)).toBe(true)
    expect(await markResult(id, false)).toBe(false)
    expect((await getCampaign(id)).status).toBe('SELECTED')
    const pending = await seedCardCampaign()
    expect(await markResult(pending, true)).toBe(false)
  })
})

describe('setReviewDeadline', () => {
  it('sets the deadline for APPLIED, SELECTED and DRAFT_REVIEW only', async () => {
    const due = new Date('2026-10-30T14:59:00Z')
    for (const status of ['APPLIED', 'SELECTED', 'DRAFT_REVIEW']) {
      const id = await seedCampaign({ status })
      expect(await setReviewDeadline(id, due)).toBe(true)
      expect((await getCampaign(id)).review_deadline?.toISOString()).toBe(due.toISOString())
    }
    for (const status of ['PENDING_REVIEW', 'POSTED', 'REJECTED']) {
      const id = await seedCampaign({ status })
      expect(await setReviewDeadline(id, due)).toBe(false)
    }
  })

  it('clears the review reminders already sent when the date changes', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    const due = new Date('2026-10-30T14:59:00Z')
    await setReviewDeadline(id, due)
    await query(
      "insert into campaign_reminders (campaign_id, kind) values ($1, 'review-d0'), ($1, 'due-missing')",
      [id],
    )
    const kinds = async () =>
      (
        await query<{ kind: string }>(
          'select kind from campaign_reminders where campaign_id = $1 order by kind',
          [id],
        )
      ).map((r) => r.kind)

    // Same date again: nothing to resend.
    await setReviewDeadline(id, due)
    expect(await kinds()).toEqual(['due-missing', 'review-d0'])
    // A new date gets its own reminders; unrelated kinds stay.
    await setReviewDeadline(id, new Date('2026-11-05T14:59:00Z'))
    expect(await kinds()).toEqual(['due-missing'])
  })
})

describe('expireCampaigns', () => {
  it('expires open campaigns past their deadline and returns the cards', async () => {
    const now = new Date('2026-10-20T00:00:00Z')
    const past = new Date('2026-10-19T14:59:00Z')
    const future = new Date('2026-10-25T14:59:00Z')
    const card = await seedCardCampaign({ apply_deadline: past })
    const collected = await seedCampaign({ status: 'COLLECTED', apply_deadline: past })
    const shortlisted = await seedCampaign({ status: 'SHORTLISTED', apply_deadline: past })
    const open = await seedCardCampaign({ apply_deadline: future })
    const applied = await seedCampaign({ status: 'APPLIED', apply_deadline: past })
    const noDeadline = await seedCardCampaign()

    const rows = await expireCampaigns(now)
    expect(rows.map((r) => r.id).sort()).toEqual([card, collected, shortlisted].sort())
    expect(rows.find((r) => r.id === card)).toMatchObject({
      review_chat_id: 1,
      review_message_id: 100,
    })
    expect((await getCampaign(card)).status).toBe('EXPIRED')
    expect((await getCampaign(open)).status).toBe('PENDING_REVIEW')
    expect((await getCampaign(applied)).status).toBe('APPLIED')
    expect((await getCampaign(noDeadline)).status).toBe('PENDING_REVIEW')
  })
})

describe('loadActiveCampaigns', () => {
  it('returns active statuses ordered by the next relevant date, nulls last', async () => {
    const d = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T14:59:00Z`)
    const selectedLate = await seedCampaign({ status: 'SELECTED', review_deadline: d(20) })
    const pendingSoon = await seedCardCampaign({ apply_deadline: d(2) })
    const selectedNone = await seedCampaign({ status: 'SELECTED' })
    const appliedMid = await seedCampaign({ status: 'APPLIED', apply_deadline: d(10) })
    const draft = await seedCampaign({ status: 'DRAFT_REVIEW', review_deadline: d(15) })
    await seedCampaign({ status: 'POSTED' })
    await seedCampaign({ status: 'REJECTED' })
    // review_deadline must not affect an APPLIED row's position.
    await query('update campaigns set review_deadline = $2 where id = $1', [appliedMid, d(1)])

    const rows = await loadActiveCampaigns()
    expect(rows.map((r) => r.id)).toEqual([
      pendingSoon,
      appliedMid,
      draft,
      selectedLate,
      selectedNone,
    ])
  })
})

describe('runCampaignReminders', () => {
  const tz = 'Asia/Seoul'

  it('sends each reminder once', async () => {
    const id = await seedCampaign({
      status: 'SELECTED',
      selected_at: new Date('2026-10-20T00:00:00Z'),
      review_deadline: new Date('2026-10-30T14:59:00Z'),
    })
    const sent: string[] = []
    const send = async (text: string) => {
      sent.push(text)
    }
    const now = new Date('2026-10-27T03:00:00Z') // 3 days before
    expect(await runCampaignReminders(send, now, tz)).toBe(1)
    expect(await runCampaignReminders(send, now, tz)).toBe(0)
    expect(sent).toHaveLength(1)
    const kinds = await query<{ kind: string }>(
      'select kind from campaign_reminders where campaign_id = $1',
      [id],
    )
    expect(kinds.map((k) => k.kind)).toEqual(['review-d3'])
    // The day before the deadline yields the next, more specific reminder.
    expect(await runCampaignReminders(send, new Date('2026-10-29T03:00:00Z'), tz)).toBe(1)
  })

  it('retries after a failed send and still sends the others', async () => {
    const a = await seedCampaign({
      status: 'APPLIED',
      apply_deadline: new Date('2026-10-10T14:59:00Z'),
    })
    const b = await seedCampaign({
      status: 'APPLIED',
      apply_deadline: new Date('2026-10-10T14:59:00Z'),
    })
    const now = new Date('2026-10-18T00:00:00Z')
    const delivered: string[] = []
    let failFirst = true
    const send = async (text: string) => {
      if (failFirst && text.includes(`#${a} `)) {
        failFirst = false
        throw new Error('telegram down')
      }
      delivered.push(text)
    }
    expect(await runCampaignReminders(send, now, tz)).toBe(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain(`#${b} `)
    const left = await query('select 1 from campaign_reminders where campaign_id = $1', [a])
    expect(left).toHaveLength(0)

    expect(await runCampaignReminders(send, now, tz)).toBe(1)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toContain(`#${a} `)
  })
})
