import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { nextFreeSlot } from '../lib/time.ts'
import { getThreadsApi } from '../threads/account.ts'
import type { TextPost, ThreadsApi } from '../threads/client.ts'

const MAX_ATTEMPTS = 3
// A PUBLISHING row untouched this long belongs to a crashed worker and may be resumed.
const STALE_PUBLISHING_MINUTES = 10

/** Approves a reviewed draft and assigns it the next free publish slot. */
export async function approvePost(postId: number, now = new Date()): Promise<Date> {
  const taken = await query<{ scheduled_at: Date }>(
    `select scheduled_at from posts
     where status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED') and scheduled_at >= $1`,
    [now],
  )
  const at = nextFreeSlot({
    now,
    slots: config.PUBLISH_SLOTS,
    timeZone: config.TZ_NAME,
    taken: taken.map((r) => r.scheduled_at),
  })
  const rows = await query(
    `update posts set status = 'SCHEDULED', scheduled_at = $2, updated_at = now()
     where id = $1 and status in ('PENDING_REVIEW', 'APPROVED')
     returning id`,
    [postId, at],
  )
  if (rows.length === 0) throw new Error(`post ${postId} is not awaiting review`)
  return at
}

export async function rejectPost(postId: number): Promise<void> {
  await query(
    "update posts set status = 'REJECTED', updated_at = now() where id = $1 and status = 'PENDING_REVIEW'",
    [postId],
  )
}

/** Posts whose slot has come, plus PUBLISHING rows abandoned by a crashed worker. */
export async function duePostIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from posts
     where (status = 'SCHEDULED' and scheduled_at <= now())
        or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $1))
     order by scheduled_at`,
    [STALE_PUBLISHING_MINUTES],
  )
  return rows.map((r) => r.id)
}

type Sleep = (ms: number) => Promise<void>
const sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Drives one Threads post from container to published. Reuses `containerId` when a previous
 * attempt already created one, so a retry never creates a second post.
 */
export async function driveContainer(
  api: ThreadsApi,
  post: TextPost,
  containerId: string | null,
  onContainer: (id: string) => Promise<void>,
  opts: { sleep?: Sleep; pollMs?: number; maxPolls?: number } = {},
): Promise<{ platformPostId: string | null }> {
  const wait = opts.sleep ?? sleep
  let id = containerId
  if (id) {
    const { status } = await api.getContainerStatus(id)
    // The previous attempt published but crashed before saving the result.
    if (status === 'PUBLISHED') return { platformPostId: null }
    if (status === 'ERROR' || status === 'EXPIRED') id = null
  }
  if (!id) {
    id = await api.createTextContainer(post)
    await onContainer(id)
  }
  for (let i = 0; ; i++) {
    const { status, error } = await api.getContainerStatus(id)
    if (status === 'FINISHED') break
    if (status === 'PUBLISHED') return { platformPostId: null }
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`container ${id} ${status}: ${error ?? 'no detail'}`)
    }
    if (i >= (opts.maxPolls ?? 12)) throw new Error(`container ${id} still ${status}`)
    await wait(opts.pollMs ?? 5_000)
  }
  return { platformPostId: await api.publish(id) }
}

export type PublishOutcome =
  | { kind: 'published'; platformPostId: string | null }
  | { kind: 'skipped' }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string }

export async function publishPost(postId: number, api?: ThreadsApi): Promise<PublishOutcome> {
  // Claiming the row is the lock: only one worker can move it into PUBLISHING.
  const [post] = await query<{
    text: string
    source_url: string | null
    container_id: string | null
    attempts: number
    topic_tag: string | null
  }>(
    `update posts set status = 'PUBLISHING', attempts = attempts + 1, updated_at = now()
     where id = $1
       and (status = 'SCHEDULED'
            or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $2)))
     returning text, source_url, container_id, attempts, generation->>'topic_tag' as topic_tag`,
    [postId, STALE_PUBLISHING_MINUTES],
  )
  if (!post) return { kind: 'skipped' }

  try {
    const { platformPostId } = await driveContainer(
      api ?? (await getThreadsApi()),
      { text: post.text, linkAttachment: post.source_url, topicTag: post.topic_tag },
      post.container_id,
      async (containerId) => {
        await query('update posts set container_id = $2, updated_at = now() where id = $1', [
          postId,
          containerId,
        ])
      },
    )
    await query(
      `update posts set status = 'PUBLISHED', platform_post_id = $2, published_at = now(),
         last_error = null, updated_at = now()
       where id = $1`,
      [postId, platformPostId],
    )
    return { kind: 'published', platformPostId }
  } catch (err) {
    const error = (err as Error).message
    const failed = post.attempts >= MAX_ATTEMPTS
    // Back to SCHEDULED so the next due-sweep retries it.
    await query('update posts set status = $2, last_error = $3, updated_at = now() where id = $1', [
      postId,
      failed ? 'FAILED' : 'SCHEDULED',
      error,
    ])
    return failed ? { kind: 'failed', error } : { kind: 'retry', error }
  }
}
