import { describe, expect, it } from 'vitest'
import {
  approveApply,
  expirePastDeadline,
  loadActiveCampaigns,
  markAppliedManually,
  markCardSent,
  rejectCampaign,
  replaceApplyMessage,
  retryApply,
} from '../../src/campaigns/review.ts'
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

describe('owner decisions', () => {
  it('markAppliedManually sets APPLIED and applied_at', async () => {
    const id = await seedCardCampaign()
    expect(await markAppliedManually(id, 0)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('APPLIED')
    expect(c.applied_at).not.toBeNull()
    expect(await markAppliedManually(id, 0)).toBe(false)
  })
  it('approveApply sets APPROVED with attempts reset', async () => {
    const id = await seedCardCampaign({ attempts: 2, last_error: 'old' })
    expect(await approveApply(id, 0)).toBe(true)
    const c = await getCampaign(id)
    expect([c.status, c.attempts, c.last_error]).toEqual(['APPROVED', 0, null])
    expect(await approveApply(id, 0)).toBe(false)
  })
  it('rejectCampaign stores the reason', async () => {
    const id = await seedCardCampaign()
    expect(await rejectCampaign(id, 0, 'reward')).toBe(true)
    const c = await getCampaign(id)
    expect([c.status, c.reject_reason]).toEqual(['REJECTED', 'reward'])
  })
  it('refuses every decision on a stale revision', async () => {
    const id = await seedCardCampaign({ revision: 1, review_revision: 0 })
    expect(await markAppliedManually(id, 0)).toBe(false)
    expect(await approveApply(id, 0)).toBe(false)
    expect(await rejectCampaign(id, 0, 'other')).toBe(false)
    expect(await approveApply(id, 1)).toBe(false) // card for revision 1 was never sent
    expect((await getCampaign(id)).status).toBe('PENDING_REVIEW')
  })
  it('refuses decisions once the campaign left PENDING_REVIEW', async () => {
    const id = await seedCardCampaign({ status: 'EXPIRED' })
    expect(await approveApply(id, 0)).toBe(false)
    expect(await rejectCampaign(id, 0, 'other')).toBe(false)
  })
})

describe('replaceApplyMessage', () => {
  it('replaces verbatim and bumps revision', async () => {
    const id = await seedCardCampaign()
    const r = await replaceApplyMessage(id, 100, '  새 메시지  ', 50)
    expect(r).toEqual({ ok: true, revision: 1 })
    const c = await getCampaign(id)
    expect(c.apply_message).toBe('새 메시지')
    expect(c.revision).toBe(1)
    expect(c.review_revision).toBe(0)
    // the old card's buttons no longer match
    expect(await approveApply(id, 0)).toBe(false)
  })
  it('rejects text over the limit without writing', async () => {
    const id = await seedCardCampaign()
    const r = await replaceApplyMessage(id, 100, 'a'.repeat(51), 50)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('50자')
    expect((await getCampaign(id)).revision).toBe(0)
  })
  it('rejects empty text', async () => {
    const id = await seedCardCampaign()
    expect((await replaceApplyMessage(id, 100, '   ', 50)).ok).toBe(false)
  })
  it('refuses a reply to an older card or a decided campaign', async () => {
    const id = await seedCardCampaign()
    expect((await replaceApplyMessage(id, 99, 'x', 50)).ok).toBe(false)
    await approveApply(id, 0)
    expect((await replaceApplyMessage(id, 100, 'x', 50)).ok).toBe(false)
  })
})

describe('retryApply', () => {
  it('moves APPLY_FAILED back to APPROVED and clears the error', async () => {
    const id = await seedCampaign({ status: 'APPLY_FAILED', attempts: 3, last_error: 'boom' })
    expect(await retryApply(id)).toBe(true)
    const c = await getCampaign(id)
    expect([c.status, c.attempts, c.last_error]).toEqual(['APPROVED', 0, null])
    expect(await retryApply(id)).toBe(false)
  })
})

describe('expirePastDeadline', () => {
  it('expires only cards past their deadline and returns their messages', async () => {
    const now = new Date('2026-10-20T00:00:00Z')
    const past = await seedCardCampaign({ apply_deadline: new Date('2026-10-19T00:00:00Z') })
    const shortlisted = await seedCampaign({
      status: 'SHORTLISTED',
      apply_deadline: new Date('2026-10-19T12:00:00Z'),
    })
    const future = await seedCardCampaign({
      review_message_id: 101,
      apply_deadline: new Date('2026-10-25T00:00:00Z'),
    })
    const applied = await seedCampaign({
      status: 'APPLIED',
      apply_deadline: new Date('2026-10-01T00:00:00Z'),
    })
    const noDeadline = await seedCardCampaign({ review_message_id: 102 })

    const expired = await expirePastDeadline(now)
    expect(expired.map((e) => e.id).sort()).toEqual([past, shortlisted].sort())
    expect(expired.find((e) => e.id === past)).toMatchObject({
      review_chat_id: 1,
      review_message_id: 100,
    })
    expect((await getCampaign(future)).status).toBe('PENDING_REVIEW')
    expect((await getCampaign(applied)).status).toBe('APPLIED')
    expect((await getCampaign(noDeadline)).status).toBe('PENDING_REVIEW')
    expect(await expirePastDeadline(now)).toEqual([])
  })
})

describe('loadActiveCampaigns', () => {
  it('lists in-progress campaigns by next deadline and hides finished ones', async () => {
    const later = await seedCampaign({
      status: 'PENDING_REVIEW',
      apply_deadline: new Date('2026-10-30T00:00:00Z'),
    })
    const sooner = await seedCampaign({
      status: 'APPLIED',
      announce_at: new Date('2026-10-22T00:00:00Z'),
    })
    const review = await seedCampaign({
      status: 'DRAFT_SAVED',
      review_deadline: new Date('2026-11-05T00:00:00Z'),
    })
    const undated = await seedCampaign({ status: 'SELECTED' })
    for (const status of [
      'REJECTED',
      'EXPIRED',
      'NOT_SELECTED',
      'POSTED',
      'SKIPPED',
      'SHORTLISTED',
    ])
      await seedCampaign({ status })

    const rows = await loadActiveCampaigns()
    expect(rows.map((r) => r.id)).toEqual([sooner, later, review, undated])
  })
})
