import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { publishPost, unschedulePost } from '../../src/pipeline/publish.ts'
import { FakeThreads } from '../fake-threads.ts'
import { getPost, seedPost, seedTopic } from './helpers.ts'

/** A SCHEDULED post whose first attempt failed after creating its container. */
async function failedOnce(api: FakeThreads) {
  const postId = await seedPost(await seedTopic(), { status: 'SCHEDULED', text: 'old text' })
  await query(
    "update posts set scheduled_at = date_trunc('milliseconds', now()) - interval '1 minute' where id = $1",
    [postId],
  )
  const realPublish = api.publish.bind(api)
  api.publish = async () => {
    throw new Error('Threads POST /threads_publish 500')
  }
  expect(await publishPost(postId, api)).toMatchObject({ kind: 'retry' })
  api.publish = realPublish
  const post = await getPost(postId)
  expect(post.container_id).not.toBeNull()
  return postId
}

describe('publishPost container reuse', () => {
  it('reuses the container of an unchanged post', async () => {
    const api = new FakeThreads()
    const postId = await failedOnce(api)
    expect(await publishPost(postId, api)).toMatchObject({ kind: 'published' })
    expect(api.created).toHaveLength(1)
    expect(api.publishCalls).toEqual([api.created[0]?.id])
  })

  it('publishes the edited text, not the container left by an earlier attempt', async () => {
    const api = new FakeThreads()
    const postId = await failedOnce(api)
    const { scheduled_at } = await getPost(postId)
    if (!scheduled_at) throw new Error('not scheduled')

    // The owner takes it back to review, edits it and approves it again.
    expect(await unschedulePost(postId, scheduled_at)).toBe(true)
    await query(
      `update posts set text = 'new text', revision = revision + 1, status = 'SCHEDULED',
         scheduled_at = now() - interval '1 minute', attempts = 0 where id = $1`,
      [postId],
    )

    expect(await publishPost(postId, api)).toMatchObject({ kind: 'published' })
    expect(api.created.map((c) => c.post.text)).toEqual(['old text', 'new text'])
    expect(api.publishCalls).toEqual([api.created[1]?.id])
  })
})
