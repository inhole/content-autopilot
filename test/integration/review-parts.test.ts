import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.ts'
import { query, transaction } from '../../src/db/pool.ts'
import { lastFollowupLimit, loadParts, replaceParts } from '../../src/pipeline/parts.ts'
import { applyReviewEdit } from '../../src/review/telegram.ts'
import { getPost, seedPost, seedTopic } from './helpers.ts'

const MSG = 500

async function seedReview(followups: string[]) {
  const postId = await seedPost(await seedTopic(), { text: 'main' })
  await query('update posts set review_message_id = $2, review_revision = revision where id = $1', [
    postId,
    MSG,
  ])
  await transaction((q) => replaceParts(q, postId, followups))
  return postId
}

const texts = async (postId: number) => (await loadParts(postId)).map((p) => [p.idx, p.text])

describe('applyReviewEdit', () => {
  it('edits a follow-up and bumps the revision', async () => {
    const id = await seedReview(['a', 'b'])
    expect(await applyReviewEdit(id, MSG, { kind: 'edit', idx: 3, text: 'B' })).toEqual({
      ok: true,
    })
    expect(await texts(id)).toEqual([
      [2, 'a'],
      [3, 'B'],
    ])
    expect((await getPost(id)).revision).toBe(2)
  })

  it('edits the main text with 수정1', async () => {
    const id = await seedReview(['a'])
    await applyReviewEdit(id, MSG, { kind: 'edit', idx: 1, text: 'new main' })
    const [row] = await query<{ text: string }>('select text from posts where id = $1', [id])
    expect(row?.text).toBe('new main')
    expect(await texts(id)).toEqual([[2, 'a']])
  })

  it('renumbers after a delete', async () => {
    const id = await seedReview(['a', 'b'])
    expect(await applyReviewEdit(id, MSG, { kind: 'delete', idx: 2 })).toEqual({ ok: true })
    expect(await texts(id)).toEqual([[2, 'b']])
    expect((await getPost(id)).revision).toBe(2)
  })

  it('changes nothing with a stale message or revision', async () => {
    const id = await seedReview(['a'])
    const stale = await applyReviewEdit(id, MSG + 1, { kind: 'delete', idx: 2 })
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    await query('update posts set revision = revision + 1 where id = $1', [id])
    expect(await applyReviewEdit(id, MSG, { kind: 'edit', idx: 2, text: 'x' })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    expect(await texts(id)).toEqual([[2, 'a']])
    expect((await getPost(id)).revision).toBe(2)
  })

  it('refuses a post that is no longer pending', async () => {
    const id = await seedReview(['a'])
    await query("update posts set status = 'SCHEDULED' where id = $1", [id])
    expect(await applyReviewEdit(id, MSG, { kind: 'delete', idx: 2 })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
  })

  it('rejects invalid operations without changing anything', async () => {
    const id = await seedReview(['a', 'b'])
    const bad = [
      { kind: 'delete', idx: 1 },
      { kind: 'delete', idx: 4 },
      { kind: 'edit', idx: 4, text: 'x' },
      { kind: 'edit', idx: 2, text: '' },
      { kind: 'edit', idx: 1, text: 'x'.repeat(501) },
      { kind: 'edit', idx: 3, text: 'x'.repeat(lastFollowupLimit(config.THREAD_CTA_TEXT) + 1) },
    ] as const
    for (const op of bad) {
      expect(await applyReviewEdit(id, MSG, op)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect(await texts(id)).toEqual([
      [2, 'a'],
      [3, 'b'],
    ])
    expect((await getPost(id)).revision).toBe(1)
  })

  it('checks the limit of the part that becomes the last one on delete', async () => {
    const original = config.THREAD_CTA_TEXT
    try {
      // With a CTA the 500-char part no longer fits as the last reply.
      config.THREAD_CTA_TEXT = '팔로우'
      const withCta = await seedReview(['y'.repeat(500), 'z'])
      expect(await applyReviewEdit(withCta, MSG, { kind: 'delete', idx: 3 })).toMatchObject({
        ok: false,
        reason: 'invalid',
      })
      expect((await loadParts(withCta)).length).toBe(2)

      config.THREAD_CTA_TEXT = undefined
      const noCta = await seedReview(['y'.repeat(500), 'z'])
      expect(await applyReviewEdit(noCta, MSG, { kind: 'delete', idx: 3 })).toEqual({ ok: true })
    } finally {
      config.THREAD_CTA_TEXT = original
    }
  })
})
