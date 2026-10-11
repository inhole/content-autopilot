import { describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { answerReply, pollReplies } from '../../src/pipeline/replies.ts'
import { DryRunThreadsClient, type ThreadsReply } from '../../src/threads/client.ts'
import { seedPost, seedTopic } from './helpers.ts'

const reply = (id: string, over: Partial<ThreadsReply> = {}): ThreadsReply => ({
  id,
  text: `reply ${id}`,
  username: 'alice',
  timestamp: new Date(),
  permalink: `https://threads.net/p/${id}`,
  isOwnedByMe: false,
  hidden: false,
  ...over,
})

async function publishedPost(platformPostId = 'media-1') {
  const postId = await seedPost(await seedTopic(), { status: 'PUBLISHED' })
  await query('update posts set platform_post_id = $2, published_at = now() where id = $1', [
    postId,
    platformPostId,
  ])
  return postId
}

function apiWith(replies: ThreadsReply[], replyTo = vi.fn(async () => 'answer-1')) {
  return Object.assign(new DryRunThreadsClient(), {
    listReplies: vi.fn(async () => replies),
    replyTo,
  })
}

describe('pollReplies', () => {
  it('notifies a new reply once and skips owned, hidden and dry-run posts', async () => {
    await publishedPost()
    await publishedPost('dry-post-1')
    const api = apiWith([
      reply('r1'),
      reply('r2', { isOwnedByMe: true }),
      reply('r3', { hidden: true }),
    ])
    const send = vi.fn(async () => 501)

    const first = await pollReplies(send, api)
    expect(first.map((r) => r.id)).toEqual(['r1'])
    expect(api.listReplies).toHaveBeenCalledTimes(1)
    const [row] = await query<{ telegram_message_id: number }>(
      "select telegram_message_id from threads_replies where id = 'r1'",
    )
    expect(row?.telegram_message_id).toBe(501)

    expect(await pollReplies(send, api)).toEqual([])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retries a failed notification on the next poll', async () => {
    await publishedPost()
    const api = apiWith([reply('r1')])
    const failing = vi.fn(async () => {
      throw new Error('telegram down')
    })
    expect(await pollReplies(failing, api)).toEqual([])
    expect((await pollReplies(async () => 7, api)).map((r) => r.id)).toEqual(['r1'])
  })

  it('isolates a failing post', async () => {
    await publishedPost('media-1')
    await publishedPost('media-2')
    const api = apiWith([reply('r1')])
    api.listReplies.mockRejectedValueOnce(new Error('boom'))
    const fresh = await pollReplies(async () => 1, api)
    expect(fresh.map((r) => r.id)).toEqual(['r1'])
  })
})

describe('answerReply', () => {
  async function notified() {
    await publishedPost()
    const api = apiWith([reply('r1')])
    await pollReplies(async () => 900, api)
    return api
  }

  it('returns null for an unrelated message', async () => {
    expect(await answerReply(1234, 'hi', apiWith([]))).toBeNull()
  })

  it('posts the answer once and refuses a second attempt', async () => {
    const api = await notified()
    const done = await answerReply(900, '고마워요', api)
    expect(done?.permalink).toBe('https://threads.net/p/r1')
    expect(api.replyTo).toHaveBeenCalledWith('r1', '고마워요')
    await expect(answerReply(900, 'again', api)).rejects.toThrow(/이미/)
    expect(api.replyTo).toHaveBeenCalledTimes(1)
    const [row] = await query<{ answer_state: string; answer_media_id: string }>(
      "select answer_state, answer_media_id from threads_replies where id = 'r1'",
    )
    expect(row).toEqual({ answer_state: 'ANSWERED', answer_media_id: 'answer-1' })
  })

  it('never double-posts for concurrent answers', async () => {
    const api = await notified()
    const results = await Promise.allSettled([
      answerReply(900, 'a', api),
      answerReply(900, 'b', api),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(api.replyTo).toHaveBeenCalledTimes(1)
  })

  it('releases the claim when Threads fails so the owner can retry', async () => {
    const api = await notified()
    api.replyTo.mockRejectedValueOnce(new Error('threads down'))
    await expect(answerReply(900, 'a', api)).rejects.toThrow('threads down')
    expect(await answerReply(900, 'a', api)).not.toBeNull()
  })

  it('rejects over-limit text before claiming', async () => {
    const api = await notified()
    await expect(answerReply(900, '가'.repeat(501), api)).rejects.toThrow(/500자/)
    expect(await answerReply(900, 'ok', api)).not.toBeNull()
  })
})
