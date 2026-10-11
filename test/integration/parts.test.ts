import { describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pool.ts'
import { loadParts, replaceParts, retryFailedParts } from '../../src/pipeline/parts.ts'
import { seedPost, seedTopic } from './helpers.ts'

describe('post parts', () => {
  it('replaces and renumbers follow-ups', async () => {
    const postId = await seedPost(await seedTopic())
    await transaction((q) => replaceParts(q, postId, ['a', 'b']))
    await transaction((q) => replaceParts(q, postId, ['c']))
    const parts = await loadParts(postId)
    expect(parts.map((p) => [p.idx, p.text, p.status])).toEqual([[2, 'c', 'PENDING']])
  })

  it('rolls back with the transaction', async () => {
    const postId = await seedPost(await seedTopic())
    await expect(
      transaction(async (q) => {
        await replaceParts(q, postId, ['a'])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await loadParts(postId)).toEqual([])
  })

  it('resets failed parts of a published post only', async () => {
    const published = await seedPost(await seedTopic({ url: 'https://example.com/p' }), {
      status: 'PUBLISHED',
    })
    const pending = await seedPost(await seedTopic({ url: 'https://example.com/q' }))
    for (const id of [published, pending]) {
      await transaction((q) => replaceParts(q, id, ['a', 'b']))
      await query(
        "update post_parts set status = 'FAILED', attempts = 3, last_error = 'x' where post_id = $1",
        [id],
      )
    }
    expect(await retryFailedParts(published)).toBe(2)
    expect(await retryFailedParts(pending)).toBe(0)
    const [part] = await loadParts(published)
    expect(part).toMatchObject({ status: 'PENDING', attempts: 0, last_error: null })
  })
})
