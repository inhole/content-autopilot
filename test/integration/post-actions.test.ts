import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/pipeline/article.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/pipeline/article.ts')>()),
  fetchArticle: async (url: string) =>
    url.includes('fail') ? Promise.reject(new Error('x')) : null,
}))

import { query } from '../../src/db/pool.ts'
import { urlHash } from '../../src/lib/url.ts'
import { addManualTopic } from '../../src/pipeline/collect.ts'
import { loadParts } from '../../src/pipeline/parts.ts'
import { createPostActions, type PostActionDeps } from '../../src/pipeline/post-actions.ts'
import { getParts, getPost, seedParts, seedPost, seedTopic } from './helpers.ts'

type Calls = {
  regen: [number, string | undefined][]
  generate: number[]
  revive: number[]
  reviveCheck: number
  digest: number
  sent: number[]
  retired: number[][]
  notes: string[]
  approved: [number, Date][]
}
let calls: Calls
let enqueueRegenResult = true
let tgFails = false

const tg = (fn: () => void) => {
  if (tgFails) throw new Error('telegram down')
  fn()
}

const deps = (): PostActionDeps => ({
  async enqueueRegeneration(topicId, feedback) {
    calls.regen.push([topicId, feedback])
    return enqueueRegenResult
  },
  async enqueueGenerate(id) {
    calls.generate.push(id)
  },
  async enqueueRevive(id) {
    calls.revive.push(id)
  },
  async enqueueReviveCheck() {
    calls.reviveCheck++
  },
  async enqueueDigest() {
    calls.digest++
  },
  reviewer: {
    async sendForReview(id) {
      tg(() => calls.sent.push(id))
    },
    async retireReviewMessages(ids) {
      tg(() => calls.retired.push(ids))
    },
    async notify(text) {
      tg(() => calls.notes.push(text))
    },
    async notifyApproved(id, at) {
      tg(() => calls.approved.push([id, at]))
    },
  },
})

beforeEach(() => {
  calls = {
    regen: [],
    generate: [],
    revive: [],
    reviveCheck: 0,
    digest: 0,
    sent: [],
    retired: [],
    notes: [],
    approved: [],
  }
  enqueueRegenResult = true
  tgFails = false
})

const actions = () => createPostActions(deps())
const STALE = { ok: false, reason: 'stale' }

async function review(text = 'main', followups: string[] = []) {
  const topicId = await seedTopic()
  const id = await seedPost(topicId, { text })
  await seedParts(id, followups)
  const { revision } = await getPost(id)
  return { id, topicId, revision }
}

describe('approve', () => {
  it('schedules, retires the review message and sends the confirmation', async () => {
    const { id, revision } = await review()
    const out = await actions().approve(id, { revision })
    expect(out).toEqual({ ok: true, telegramSynced: true })
    const post = await getPost(id)
    expect(post.status).toBe('SCHEDULED')
    expect(calls.retired).toEqual([[id]])
    expect(calls.approved).toEqual([[id, post.scheduled_at]])
  })

  it('is stale on a wrong revision or status and not_found for an unknown id', async () => {
    const { id, revision } = await review()
    expect(await actions().approve(id, { revision: revision + 1 })).toMatchObject(STALE)
    expect((await getPost(id)).status).toBe('PENDING_REVIEW')
    await actions().approve(id, { revision })
    expect(await actions().approve(id, { revision })).toMatchObject(STALE)
    expect(await actions().approve(99999, { revision: 1 })).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })

  it('keeps the approval when Telegram fails', async () => {
    const { id, revision } = await review()
    tgFails = true
    expect(await actions().approve(id, { revision })).toEqual({ ok: true, telegramSynced: false })
    expect((await getPost(id)).status).toBe('SCHEDULED')
  })
})

describe('reject', () => {
  it('discards with the reason and tells Telegram', async () => {
    const { id, revision } = await review()
    const out = await actions().reject(id, { revision, reason: 'topic' })
    expect(out).toEqual({ ok: true, telegramSynced: true })
    const [row] = await query<{ status: string; reject_reason: string }>(
      'select status, reject_reason from posts where id = $1',
      [id],
    )
    expect(row).toEqual({ status: 'REJECTED', reject_reason: 'topic' })
    expect(calls.retired).toEqual([[id]])
    expect(calls.notes[0]).toContain(`#${id} 폐기`)
  })

  it('is stale on a wrong revision and changes nothing', async () => {
    const { id, revision } = await review()
    expect(await actions().reject(id, { revision: revision + 1, reason: 'topic' })).toMatchObject(
      STALE,
    )
    expect((await getPost(id)).status).toBe('PENDING_REVIEW')
    expect(calls.notes).toEqual([])
  })
})

describe('regenerate', () => {
  it('queues the topic with trimmed feedback and notifies', async () => {
    const { id, topicId, revision } = await review()
    const out = await actions().regenerate(id, { revision, feedback: '  더 짧게  ' })
    expect(out).toEqual({ ok: true, telegramSynced: true })
    expect(calls.regen).toEqual([[topicId, '더 짧게']])
    expect(calls.retired).toEqual([[id]])
    expect(calls.notes).toEqual([`🔁 #${id} 재생성 중…`])
  })

  it('treats blank feedback as none, and a refused enqueue as stale', async () => {
    const { id, topicId, revision } = await review()
    enqueueRegenResult = false
    expect(await actions().regenerate(id, { revision, feedback: '   ' })).toMatchObject(STALE)
    expect(calls.regen).toEqual([[topicId, undefined]])
    expect(calls.notes).toEqual([])
    expect(await actions().regenerate(id, { revision: revision + 1 })).toMatchObject(STALE)
  })
})

describe('edit and deletePart', () => {
  it('replaces the main text, bumps the revision and re-sends the review', async () => {
    const { id, revision } = await review()
    const out = await actions().edit(id, { revision, idx: 1, text: ' new main ' })
    expect(out).toEqual({ ok: true, telegramSynced: true })
    const [row] = await query<{ text: string; revision: number }>(
      'select text, revision from posts where id = $1',
      [id],
    )
    expect(row).toEqual({ text: 'new main', revision: revision + 1 })
    expect(calls.sent).toEqual([id])
    // The same view can not edit twice.
    expect(await actions().edit(id, { revision, idx: 1, text: 'again' })).toMatchObject(STALE)
  })

  it('reports invalid edits with their message and changes nothing', async () => {
    const { id, revision } = await review('main', ['a'])
    const over = await actions().edit(id, { revision, idx: 1, text: 'x'.repeat(501) })
    expect(over).toMatchObject({ ok: false, reason: 'invalid' })
    const missing = await actions().edit(id, { revision, idx: 3, text: 'x' })
    expect(missing).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await actions().deletePart(id, { revision, idx: 1 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    expect((await getPost(id)).revision).toBe(revision)
    expect(calls.sent).toEqual([])
  })

  it('deletes a follow-up and renumbers the rest', async () => {
    const { id, revision } = await review('main', ['a', 'b'])
    expect(await actions().deletePart(id, { revision, idx: 2 })).toEqual({
      ok: true,
      telegramSynced: true,
    })
    expect((await loadParts(id)).map((p) => [p.idx, p.text])).toEqual([[2, 'b']])
    expect(calls.sent).toEqual([id])
  })

  it('is stale when the post is no longer under review', async () => {
    const { id, revision } = await review()
    await query("update posts set status = 'REJECTED' where id = $1", [id])
    expect(await actions().edit(id, { revision, idx: 1, text: 'x' })).toMatchObject(STALE)
    expect(await actions().edit(99999, { revision, idx: 1, text: 'x' })).toMatchObject({
      reason: 'not_found',
    })
  })

  it('keeps the edit when Telegram fails', async () => {
    const { id, revision } = await review()
    tgFails = true
    expect(await actions().edit(id, { revision, idx: 1, text: 'kept' })).toEqual({
      ok: true,
      telegramSynced: false,
    })
    const [row] = await query<{ text: string }>('select text from posts where id = $1', [id])
    expect(row?.text).toBe('kept')
  })
})

describe('schedule actions', () => {
  const slot = new Date(Date.now() + 3_600_000)
  const scheduled = async () => {
    const id = await seedPost(await seedTopic(), { status: 'SCHEDULED', scheduledAt: slot })
    return id
  }

  it('unschedules back to review and re-sends it', async () => {
    const id = await scheduled()
    const out = await actions().unschedule(id, { scheduledAt: slot })
    expect(out).toEqual({ ok: true, telegramSynced: true })
    expect((await getPost(id)).status).toBe('PENDING_REVIEW')
    expect(calls.notes).toEqual([`⏪ #${id} 예약 취소 · 검수 대기로 되돌렸어요`])
    expect(calls.sent).toEqual([id])
  })

  it('is stale for another slot, and not_found for an unknown id', async () => {
    const id = await scheduled()
    const other = new Date(slot.getTime() + 1000)
    expect(await actions().unschedule(id, { scheduledAt: other })).toMatchObject(STALE)
    expect(await actions().publishNow(id, { scheduledAt: other })).toMatchObject(STALE)
    expect(await actions().unschedule(99999, { scheduledAt: slot })).toMatchObject({
      reason: 'not_found',
    })
    expect((await getPost(id)).status).toBe('SCHEDULED')
  })

  it('publishes now by moving the slot', async () => {
    const id = await scheduled()
    expect(await actions().publishNow(id, { scheduledAt: slot })).toEqual({
      ok: true,
      telegramSynced: true,
    })
    const post = await getPost(id)
    expect(post.scheduled_at && post.scheduled_at.getTime() <= Date.now()).toBe(true)
    expect(calls.notes[0]).toContain(`#${id} 5분 안에 발행돼요`)
  })

  it('reports Telegram failures without undoing the change', async () => {
    const id = await scheduled()
    tgFails = true
    expect(await actions().unschedule(id, { scheduledAt: slot })).toEqual({
      ok: true,
      telegramSynced: false,
    })
    expect((await getPost(id)).status).toBe('PENDING_REVIEW')
  })
})

describe('retryParts', () => {
  it('resets failed parts and notifies the count', async () => {
    const id = await seedPost(await seedTopic(), { status: 'PUBLISHED' })
    await seedParts(id, ['a', 'b'], { status: 'FAILED', attempts: 3 })
    expect(await actions().retryParts(id)).toEqual({ ok: true, telegramSynced: true })
    expect((await getParts(id)).map((p) => p.status)).toEqual(['PENDING', 'PENDING'])
    expect(calls.notes).toEqual([`🔁 #${id} 답글 2개를 5분 안에 다시 발행해요`])
  })

  it('is stale with a message when nothing failed', async () => {
    const id = await seedPost(await seedTopic(), { status: 'PUBLISHED' })
    expect(await actions().retryParts(id)).toEqual({
      ok: false,
      reason: 'stale',
      message: '다시 시도할 답글이 없어요',
    })
    expect(await actions().retryParts(99999)).toMatchObject({ reason: 'not_found' })
  })
})

describe('revive', () => {
  const expired = async (set = '') => {
    const id = await seedPost(await seedTopic(), { status: 'EXPIRED' })
    if (set) await query(`update posts set ${set} where id = $1`, [id])
    return id
  }

  it('queues an expired news draft', async () => {
    const id = await expired()
    expect(await actions().revive(id)).toEqual({ ok: true, telegramSynced: true })
    expect(calls.revive).toEqual([id])
  })

  it('refuses drafts that are not revivable', async () => {
    const notExpired = await seedPost(await seedTopic())
    const revived = await expired('revived_at = now()')
    const digested = await expired('digest_post_id = (select min(id) from posts)')
    const digestOrigin = await expired("origin = 'digest'")
    for (const id of [notExpired, revived, digested, digestOrigin]) {
      expect(await actions().revive(id)).toMatchObject(STALE)
    }
    expect(calls.revive).toEqual([])
    expect(await actions().revive(99999)).toMatchObject({ reason: 'not_found' })
  })
})

describe('addTopic', () => {
  it('creates a topic and queues generation', async () => {
    const out = await actions().addTopic({ url: 'https://example.com/new', note: ' 의견 ' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(calls.generate).toEqual([out.topicId])
    const [row] = await query<{ title: string; note: string | null }>(
      'select title, note from topics where id = $1',
      [out.topicId],
    )
    expect(row).toEqual({ title: 'https://example.com/new', note: '의견' })
  })

  it('still adds the topic when the article fetch fails', async () => {
    const out = await actions().addTopic({ url: 'https://example.com/fail' })
    expect(out.ok).toBe(true)
  })

  it('reports an already covered article', async () => {
    const url = 'https://example.com/covered'
    const topicId = await addManualTopic('t', url)
    const postId = await seedPost(topicId, { status: 'PUBLISHED' })
    expect(urlHash(url)).toBeTruthy()
    expect(await actions().addTopic({ url })).toEqual({
      ok: false,
      reason: 'covered',
      postId,
      status: 'PUBLISHED',
    })
    expect(calls.generate).toEqual([])
  })
})

describe('queue passthroughs', () => {
  it('forwards revive-check and digest', async () => {
    await actions().reviveCheck()
    await actions().digest()
    expect(calls.reviveCheck).toBe(1)
    expect(calls.digest).toBe(1)
  })
})
