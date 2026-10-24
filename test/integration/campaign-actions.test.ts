import { beforeEach, describe, expect, it, vi } from 'vitest'

const tg = vi.hoisted(() => ({
  sent: [] as { text: string; buttons: unknown[] }[],
  cleared: [] as [number, number][],
  failSend: false,
}))
vi.mock('../../src/campaigns/tg.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/campaigns/tg.ts')>()),
  sendCampaignMessage: async (text: string, buttons: unknown[] = []) => {
    if (tg.failSend) throw new Error('telegram down')
    tg.sent.push({ text, buttons })
    return 500 + tg.sent.length
  },
  clearButtons: async (chat: number, message: number) => {
    tg.cleared.push([chat, message])
  },
}))

import { createCampaignActions } from '../../src/campaigns/actions.ts'
import { parseCampaignProfile } from '../../src/campaigns/profile.ts'
import { query } from '../../src/db/pool.ts'
import { getCampaign, seedCampaign } from './campaign-helpers-draft.ts'

const DISCLOSURE = '체험단으로 제품을 제공받아 작성한 솔직한 리뷰입니다.'
const profile = parseCampaignProfile({
  about: 'IT 개발자',
  interests: [],
  excludeKeywords: [],
  review: { tone: '담백하게', minChars: 10, maxChars: 200, points: [] },
  disclosure: DISCLOSURE,
})
vi.mock('../../src/campaigns/profile.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/campaigns/profile.ts')>()),
  loadCampaignProfile: async () => profile,
}))

const enqueued: { id: number; feedback?: string; revision?: number }[] = []
let enqueueResult = true
const actions = createCampaignActions({
  enqueueDraft: async (id, feedback, revision) => {
    enqueued.push({ id, feedback, revision })
    return enqueueResult
  },
})

const STALE = { ok: false, reason: 'stale' }
const card = (over: Record<string, unknown> = {}) =>
  seedCampaign({
    status: 'PENDING_REVIEW',
    revision: 1,
    review_chat_id: 7,
    review_message_id: 100,
    review_revision: 1,
    ...over,
  })

beforeEach(() => {
  tg.sent.length = 0
  tg.cleared.length = 0
  tg.failSend = false
  enqueued.length = 0
  enqueueResult = true
})

describe('apply and reject (revision bound)', () => {
  it('applies, strips the card keyboard and sends the result buttons', async () => {
    const id = await card()
    expect(await actions.apply(id, { revision: 1 })).toEqual({ ok: true, telegramSynced: true })
    expect((await getCampaign(id)).status).toBe('APPLIED')
    expect(tg.cleared).toEqual([[7, 100]])
    expect(tg.sent[0]?.text).toContain(`#${id} 신청 기록`)
    expect(tg.sent[0]?.buttons).toHaveLength(2)
  })
  it('refuses a stale revision and a second press, changing nothing', async () => {
    const id = await card({ revision: 2, review_revision: 2 })
    expect(await actions.apply(id, { revision: 1 })).toMatchObject(STALE)
    expect((await getCampaign(id)).status).toBe('PENDING_REVIEW')
    expect(await actions.apply(id, { revision: 2 })).toMatchObject({ ok: true })
    expect(await actions.apply(id, { revision: 2 })).toMatchObject(STALE)
    expect(tg.sent).toHaveLength(1)
  })
  it('a card press racing the web press loses cleanly', async () => {
    const id = await card()
    const [a, b] = await Promise.all([
      actions.apply(id, { revision: 1 }),
      actions.reject(id, { revision: 1, reason: 'brand' }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
  it('rejects with the reason', async () => {
    const id = await card()
    expect(await actions.reject(id, { revision: 1, reason: 'competition' })).toMatchObject({
      ok: true,
    })
    const c = await getCampaign(id)
    expect([c.status, c.reject_reason]).toEqual(['REJECTED', 'competition'])
    expect(tg.sent[0]?.text).toContain('경쟁률이 너무 높음')
  })
  it('404 for an unknown campaign', async () => {
    expect(await actions.apply(999_999, { revision: 0 })).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })
  it('still applies when Telegram fails, and says so', async () => {
    const id = await card()
    tg.failSend = true
    expect(await actions.apply(id, { revision: 1 })).toEqual({ ok: true, telegramSynced: false })
    expect((await getCampaign(id)).status).toBe('APPLIED')
  })
})

describe('result and deadline (status gated)', () => {
  it('selected: sends the draft button; unselected: a plain note', async () => {
    const yes = await seedCampaign({ status: 'APPLIED' })
    expect(await actions.result(yes, { selected: true })).toMatchObject({ ok: true })
    expect((await getCampaign(yes)).status).toBe('SELECTED')
    expect(tg.sent[0]?.buttons).toHaveLength(1)
    const no = await seedCampaign({ status: 'APPLIED' })
    expect(await actions.result(no, { selected: false })).toMatchObject({ ok: true })
    expect((await getCampaign(no)).status).toBe('NOT_SELECTED')
    expect(tg.sent[1]?.buttons).toEqual([])
  })
  it('refuses a result on a campaign that is no longer APPLIED', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    expect(await actions.result(id, { selected: false })).toMatchObject(STALE)
    expect((await getCampaign(id)).status).toBe('SELECTED')
  })
  it('sets the deadline only for the status the page showed', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    const at = new Date('2026-10-30T14:59:00Z')
    expect(await actions.deadline(id, { status: 'DRAFT_REVIEW', deadline: at })).toMatchObject(
      STALE,
    )
    expect((await getCampaign(id)).review_deadline).toBeNull()
    expect(await actions.deadline(id, { status: 'SELECTED', deadline: at })).toMatchObject({
      ok: true,
    })
    expect((await getCampaign(id)).review_deadline?.toISOString()).toBe(at.toISOString())
  })
  it('clears review reminders when the deadline changes', async () => {
    const id = await seedCampaign({ status: 'SELECTED', review_deadline: new Date('2026-10-25Z') })
    await query(`insert into campaign_reminders (campaign_id, kind) values ($1, 'review-d3')`, [id])
    await actions.deadline(id, { status: 'SELECTED', deadline: new Date('2026-11-01T14:59:00Z') })
    const left = await query('select 1 from campaign_reminders where campaign_id = $1', [id])
    expect(left).toHaveLength(0)
  })
})

describe('memo and regenerate', () => {
  it('saves the memo and queues the draft', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    expect(
      await actions.memo(id, { status: 'SELECTED', revision: 0, memo: ' 일주일 써봄 ' }),
    ).toEqual({ ok: true, telegramSynced: true })
    expect((await getCampaign(id)).memo).toBe('일주일 써봄')
    expect(enqueued).toEqual([{ id, feedback: undefined, revision: undefined }])
  })
  it('refuses a memo from an outdated view (status or revision moved on)', async () => {
    const drafted = await seedCampaign({ status: 'DRAFT_REVIEW', revision: 3, memo: '원래 메모' })
    expect(
      await actions.memo(drafted, { status: 'SELECTED', revision: 0, memo: '새 메모' }),
    ).toMatchObject(STALE)
    expect(
      await actions.memo(drafted, { status: 'DRAFT_REVIEW', revision: 2, memo: '새 메모' }),
    ).toMatchObject(STALE)
    expect((await getCampaign(drafted)).memo).toBe('원래 메모')
    expect(enqueued).toEqual([])
  })
  it('an empty memo is invalid, a wrong stage is stale', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    expect(await actions.memo(id, { status: 'SELECTED', revision: 0, memo: '   ' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    const applied = await seedCampaign({ status: 'APPLIED' })
    expect(
      await actions.memo(applied, { status: 'APPLIED', revision: 0, memo: 'x' }),
    ).toMatchObject(STALE)
  })
  it('regenerate passes the revision and feedback, and refuses an old revision', async () => {
    const id = await seedCampaign({ status: 'DRAFT_REVIEW', revision: 4, draft_text: '초안' })
    expect(await actions.regenerate(id, { revision: 3, feedback: '짧게' })).toMatchObject(STALE)
    expect(enqueued).toEqual([])
    expect(await actions.regenerate(id, { revision: 4, feedback: ' 더 짧게 ' })).toMatchObject({
      ok: true,
    })
    expect(enqueued).toEqual([{ id, feedback: '더 짧게', revision: 4 }])
    enqueueResult = false
    expect(await actions.regenerate(id, { revision: 4 })).toMatchObject(STALE)
  })
})

describe('draft edit and posted (revision bound)', () => {
  it('replaces the draft with the disclosure first, bumps the revision and resends it', async () => {
    const id = await seedCampaign({
      status: 'DRAFT_REVIEW',
      revision: 2,
      draft_text: '옛 초안',
      review_chat_id: 7,
      review_message_id: 100,
      review_revision: 2,
      regen_seq: 3,
      draft_seq: 3,
    })
    expect(await actions.draft(id, { revision: 2, text: '내가 고친 리뷰' })).toMatchObject({
      ok: true,
    })
    const c = await getCampaign(id)
    expect(c.draft_text).toBe(`${DISCLOSURE}\n\n내가 고친 리뷰`)
    expect(c.revision).toBe(3)
    // The edit supersedes queued regenerations and leaves no request pending.
    expect([c.regen_seq, c.draft_seq]).toEqual([4, 4])
    // sendDraft: the draft alone, then the control message.
    expect(tg.sent.map((m) => m.text)[0]).toBe(c.draft_text)
  })
  it('refuses a stale revision; an over-long draft is invalid', async () => {
    const id = await seedCampaign({ status: 'DRAFT_REVIEW', revision: 2, draft_text: '초안' })
    expect(await actions.draft(id, { revision: 1, text: '글' })).toMatchObject(STALE)
    expect(await actions.draft(id, { revision: 2, text: '가'.repeat(300) })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    expect((await getCampaign(id)).draft_text).toBe('초안')
  })
  it('posted works on the draft revision even without a matching control message', async () => {
    const id = await seedCampaign({
      status: 'DRAFT_REVIEW',
      revision: 5,
      review_chat_id: 7,
      review_message_id: 100,
      review_revision: 4, // the control message of an older draft
    })
    expect(await actions.posted(id, { revision: 4 })).toMatchObject(STALE)
    expect(await actions.posted(id, { revision: 5 })).toMatchObject({ ok: true })
    expect((await getCampaign(id)).status).toBe('POSTED')
    expect(tg.cleared).toEqual([[7, 100]])
    expect(tg.sent[0]?.text).toContain('리뷰 완료')
    expect(await actions.posted(id, { revision: 5 })).toMatchObject(STALE)
  })
})
