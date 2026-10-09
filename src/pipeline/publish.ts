import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { nextFreeSlot } from '../lib/time.ts'
import { getThreadsApi } from '../threads/account.ts'
import type { TextPost, ThreadsApi } from '../threads/client.ts'

const MAX_ATTEMPTS = 3
// Extra attempts allowed when we cannot tell whether the last one actually published.
const MAX_UNKNOWN_ATTEMPTS = MAX_ATTEMPTS * 2
// A PUBLISHING row untouched this long belongs to a crashed worker and may be resumed.
const STALE_PUBLISHING_MINUTES = 10

const APPROVE_SLOT_RETRIES = 5

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/**
 * Approves a reviewed draft and assigns it the next free publish slot. Pass the `revision` the
 * reviewer saw so a draft rewritten in the meantime is not approved unread.
 */
export async function approvePost(
  postId: number,
  opts: { now?: Date; revision?: number } = {},
): Promise<Date> {
  const now = opts.now ?? new Date()
  for (let attempt = 1; ; attempt++) {
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
    try {
      const rows = await query(
        `update posts set status = 'SCHEDULED', scheduled_at = $2, updated_at = now()
         where id = $1 and status in ('PENDING_REVIEW', 'APPROVED')
           and ($3::int is null or revision = $3)
         returning id`,
        [postId, at, opts.revision ?? null],
      )
      if (rows.length === 0) throw new Error(`post ${postId} is not awaiting review or has changed`)
      return at
    } catch (err) {
      // A concurrent approval took this slot (unique index); re-read taken slots and retry.
      if (!isUniqueViolation(err) || attempt >= APPROVE_SLOT_RETRIES) throw err
    }
  }
}

export async function rejectPost(postId: number, reason?: string): Promise<void> {
  await query(
    `update posts set status = 'REJECTED', reject_reason = $2, updated_at = now()
     where id = $1 and status = 'PENDING_REVIEW'`,
    [postId, reason ?? null],
  )
}

/**
 * Takes an approved post back to review. Bound to the `scheduledAt` the reviewer saw, so a button
 * on an old confirmation cannot act on a post that was rescheduled or already picked up. The
 * revision bump makes every earlier review button stale. Returns false when nothing matched.
 */
export async function unschedulePost(postId: number, scheduledAt: Date): Promise<boolean> {
  const rows = await query(
    `update posts set status = 'PENDING_REVIEW', scheduled_at = null, revision = revision + 1,
       updated_at = now()
     where id = $1 and status = 'SCHEDULED' and scheduled_at = $2
     returning id`,
    [postId, scheduledAt],
  )
  return rows.length > 0
}

/**
 * Moves a scheduled post's slot to now so the next publish-due sweep picks it up. It does not
 * publish directly: the sweep and the claim logic stay the only way a post goes out.
 */
export async function publishNow(postId: number, scheduledAt: Date): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      // The unique index on scheduled_at can in theory collide with a post already at this
      // instant; each retry shifts by a few milliseconds.
      const rows = await query(
        `update posts set scheduled_at = now() + make_interval(secs => $3::double precision),
           updated_at = now()
         where id = $1 and status = 'SCHEDULED' and scheduled_at = $2
         returning id`,
        [postId, scheduledAt, attempt * 0.001],
      )
      return rows.length > 0
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= APPROVE_SLOT_RETRIES) throw err
    }
  }
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

/** Thrown when another worker has taken over this post's claim. */
export class LostClaimError extends Error {
  constructor() {
    super('publish claim was taken over by another worker')
    this.name = 'LostClaimError'
  }
}

/**
 * Drives one Threads post from container to published. Reuses `containerId` when a previous
 * attempt already created one, so a retry never creates a second post.
 */
export async function driveContainer(
  api: ThreadsApi,
  post: TextPost,
  containerId: string | null,
  onContainer: (id: string) => Promise<void>,
  opts: {
    sleep?: Sleep
    pollMs?: number
    maxPolls?: number
    /** Runs right before the irreversible publish call; throws LostClaimError if not the owner. */
    beforePublish?: () => Promise<void>
  } = {},
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
  await opts.beforePublish?.()
  return { platformPostId: await api.publish(id) }
}

export type PublishOutcome =
  | { kind: 'published'; platformPostId: string | null }
  | { kind: 'skipped' }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string }

export type FailureDecision = 'published' | 'retry' | 'failed'

/**
 * Decides what a failed attempt means. `containerStatus` is a fresh lookup of the container
 * (null when none is known, 'unknown' when the lookup itself failed). The publish response can
 * be lost after Threads already published, so a PUBLISHED container wins over everything. If we
 * cannot tell on the final attempt, stay retryable: a wrong FAILED is never revisited by the
 * sweep and would hide a live post, while one more attempt re-checks the container safely.
 * That grace is capped so a persistent lookup failure (e.g. an expired token) still ends in
 * FAILED and gets reported instead of retrying silently forever.
 */
export function decideAfterFailure(input: {
  attempts: number
  containerStatus: string | null
}): FailureDecision {
  if (input.containerStatus === 'PUBLISHED') return 'published'
  if (input.attempts < MAX_ATTEMPTS) return 'retry'
  if (input.containerStatus === 'unknown' && input.attempts < MAX_UNKNOWN_ATTEMPTS) return 'retry'
  return 'failed'
}

export async function publishPost(postId: number, api?: ThreadsApi): Promise<PublishOutcome> {
  // Claiming the row is the lock: only one worker can move it into PUBLISHING.
  const [post] = await query<{
    text: string
    source_url: string | null
    container_id: string | null
    attempts: number
    claim_seq: number
    topic_tag: string | null
  }>(
    `update posts set status = 'PUBLISHING', attempts = attempts + 1, claim_seq = claim_seq + 1,
       updated_at = now()
     where id = $1
       and (status = 'SCHEDULED'
            or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $2)))
     returning text, source_url, container_id, attempts, claim_seq,
       generation->>'topic_tag' as topic_tag`,
    [postId, STALE_PUBLISHING_MINUTES],
  )
  if (!post) return { kind: 'skipped' }

  // `claim_seq` is bumped by every claim and never reset, so it identifies this claim: if the
  // stale-claim sweep re-claimed the row, the token no longer matches and our writes must not land.
  // (`attempts` cannot serve as the token: publish-now resets it.)
  const token = post.claim_seq
  // Ownership-checked update; false means the claim was lost. $1 = id, $2 = token, extras from $3.
  const ownedUpdate = async (set: string, params: unknown[] = []): Promise<boolean> => {
    const rows = await query(
      `update posts set ${set}, updated_at = now()
       where id = $1 and status = 'PUBLISHING' and claim_seq = $2
       returning id`,
      [postId, token, ...params],
    )
    return rows.length > 0
  }

  // Resolved inside try: a missing/invalid token must go through the failure path, not leave
  // the row stuck in PUBLISHING to be silently re-claimed every few minutes.
  let threads: ThreadsApi | undefined = api
  let containerId = post.container_id
  try {
    threads ??= await getThreadsApi()
    const { platformPostId } = await driveContainer(
      threads,
      { text: post.text, linkAttachment: post.source_url, topicTag: post.topic_tag },
      post.container_id,
      async (id) => {
        containerId = id
        if (!(await ownedUpdate('container_id = $3', [id]))) throw new LostClaimError()
      },
      {
        // Doubles as a heartbeat: bumps updated_at so a slow but live worker is not reclaimed.
        beforePublish: async () => {
          if (!(await ownedUpdate('status = status'))) throw new LostClaimError()
        },
      },
    )
    const saved = await ownedUpdate(
      `status = 'PUBLISHED', platform_post_id = $3, published_at = now(), last_error = null`,
      [platformPostId],
    )
    return saved ? { kind: 'published', platformPostId } : { kind: 'skipped' }
  } catch (err) {
    if (err instanceof LostClaimError) return { kind: 'skipped' }
    const error = (err as Error).message
    let containerStatus: string | null = null
    if (containerId) {
      try {
        if (!threads) throw new Error('Threads client unavailable')
        containerStatus = (await threads.getContainerStatus(containerId)).status
      } catch {
        containerStatus = 'unknown'
      }
    }
    const decision = decideAfterFailure({ attempts: post.attempts, containerStatus })
    if (decision === 'published') {
      const saved = await ownedUpdate(
        `status = 'PUBLISHED', published_at = now(), last_error = null`,
      )
      return saved ? { kind: 'published', platformPostId: null } : { kind: 'skipped' }
    }
    // Back to SCHEDULED so the next due-sweep retries it.
    const saved = await ownedUpdate(
      `status = '${decision === 'failed' ? 'FAILED' : 'SCHEDULED'}', last_error = $3`,
      [error],
    )
    if (!saved) return { kind: 'skipped' }
    return decision === 'failed' ? { kind: 'failed', error } : { kind: 'retry', error }
  }
}
