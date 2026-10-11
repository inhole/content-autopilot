import { query } from '../db/pool.ts'
import { getThreadsApi } from '../threads/account.ts'
import type { ThreadsApi, ThreadsOwnPost } from '../threads/client.ts'
import { composeChain, loadParts, type PostPart } from './parts.ts'
import {
  decideAfterFailure,
  driveContainer,
  LostClaimError,
  STALE_PUBLISHING_MINUTES,
} from './publish.ts'
import { REPLY_POLL_WINDOW_HOURS } from './replies.ts'

// Publishes the follow-up parts of a thread chain (docs/decisions.md 8) after the main post is up.
// The safety model is publishPost's, applied per part: the post_parts row is the source of truth,
// a claim bumps claim_seq (the ownership token), container_id is saved before publishing and a
// failed attempt re-checks the container, so a retry never posts the same part twice.

export type ChainOutcome =
  | { kind: 'done'; published: number }
  | { kind: 'skipped' }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string; idx: number }

/**
 * Published posts that still have follow-ups to publish: a PENDING part, or one stuck in
 * PUBLISHING by a crashed worker. Parts behind a FAILED part are left out: the chain stops there
 * until the owner retries, and listing them would enqueue a no-op job every sweep. Also posts
 * with a published part whose media id is still unknown (lost response), while replies on it are
 * polled: publishChain recovers that id, and without it the part's replies are never read.
 */
export async function dueChainPostIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select p.id from posts p
     where p.status = 'PUBLISHED'
       and (exists (
         select 1 from post_parts pp
         where pp.post_id = p.id
           and (pp.status = 'PENDING'
                or (pp.status = 'PUBLISHING'
                    and pp.updated_at < now() - make_interval(mins => $1)))
           and not exists (
             select 1 from post_parts f
             where f.post_id = pp.post_id and f.idx < pp.idx and f.status = 'FAILED'))
         or exists (
           select 1 from post_parts pp
           where pp.post_id = p.id and pp.status = 'PUBLISHED' and pp.platform_post_id is null
             and coalesce(pp.published_at, p.published_at) > now() - make_interval(hours => $2)))
     order by p.id`,
    [STALE_PUBLISHING_MINUTES, REPLY_POLL_WINDOW_HOURS],
  )
  return rows.map((r) => r.id)
}

/**
 * Posts with a FAILED part the owner has not been told about yet, with that part's error; only
 * `postId`'s when given (the alert job re-checks right before sending).
 */
export async function unalertedChainFailures(
  postId?: number,
): Promise<{ postId: number; error: string }[]> {
  const rows = await query<{ post_id: number; last_error: string | null }>(
    `select distinct on (post_id) post_id, last_error from post_parts
     where status = 'FAILED' and alerted_at is null and ($1::bigint is null or post_id = $1)
     order by post_id, idx`,
    [postId ?? null],
  )
  return rows.map((r) => ({ postId: r.post_id, error: r.last_error ?? 'unknown error' }))
}

/** Records that the owner was alerted about the post's FAILED parts (after the send succeeded). */
export async function markChainAlerted(postId: number): Promise<void> {
  await query(
    `update post_parts set alerted_at = now()
     where post_id = $1 and status = 'FAILED' and alerted_at is null`,
    [postId],
  )
}

// Lost-response recovery may only look at items published after the post's slot (minus clock skew).
const RECOVERY_SKEW_MS = 5 * 60_000

/**
 * The media id of the item whose text is exactly what we sent. Identical text can exist under
 * another post, so a reply must answer `repliedToId` and items older than `notBefore` are
 * ignored. An item whose parent or timestamp the API omitted cannot be verified and is never
 * matched, and more than one candidate is treated as unknown: attaching the next part to the
 * wrong thread is worse than a failed attempt.
 */
export function findMediaIdByText(
  items: ThreadsOwnPost[],
  sentText: string,
  opts: { repliedToId?: string; notBefore?: Date | null } = {},
): string | null {
  const wanted = sentText.trim()
  const notBefore = opts.notBefore?.getTime()
  const candidates = items.filter(
    (i) =>
      i.text !== null &&
      i.text.trim() === wanted &&
      (notBefore === undefined || (i.timestamp !== null && i.timestamp.getTime() >= notBefore)) &&
      (opts.repliedToId === undefined || i.repliedToId === opts.repliedToId),
  )
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null
}

/**
 * The previous part, whose media id the next part replies to. `id` is null when the publish
 * response was lost (driveContainer returns null for an already-PUBLISHED container); it is then
 * recovered from our recent posts by exact text and saved through `save`.
 */
type Parent = {
  id: string | null
  /** The exact text that was sent for it, CTA included. */
  text: string
  /** The part this one replies to; null for the main post, which is a top-level thread. */
  repliesTo: Parent | null
  label: string
  save: (id: string) => Promise<void>
}

async function resolveParentId(
  threads: ThreadsApi,
  parent: Parent,
  notBefore: Date | null,
): Promise<string> {
  if (parent.id) return parent.id
  const id = parent.repliesTo
    ? findMediaIdByText(await threads.listMyReplies(), parent.text, {
        repliedToId: await resolveParentId(threads, parent.repliesTo, notBefore),
        notBefore,
      })
    : findMediaIdByText(await threads.listMyThreads(), parent.text, { notBefore })
  // Without the parent id a reply cannot be attached, so this is a failed attempt of the part.
  if (!id) throw new Error(`cannot resolve the Threads media id of ${parent.label}`)
  await parent.save(id)
  parent.id = id
  return id
}

/**
 * Publishes the pending follow-ups of a PUBLISHED post in order, each as a reply to the part
 * before it, stopping at the first part that does not end up PUBLISHED. Safe to call concurrently
 * and repeatedly: whoever fails to claim a part leaves it alone.
 */
export async function publishChain(postId: number, api?: ThreadsApi): Promise<ChainOutcome> {
  const [post] = await query<{
    text: string
    source_url: string | null
    platform_post_id: string | null
    topic_tag: string | null
    scheduled_at: Date | null
  }>(
    `select text, source_url, platform_post_id, generation->>'topic_tag' as topic_tag,
       scheduled_at
     from posts where id = $1 and status = 'PUBLISHED'`,
    [postId],
  )
  if (!post) return { kind: 'skipped' }
  const parts = await loadParts(postId)
  if (parts.length === 0) return { kind: 'done', published: 0 }

  // chain[0] is the main post; chain[i + 1] is parts[i] exactly as it goes out (link and CTA on
  // the last one), which is also the text to look for when a media id has to be recovered.
  const chain = composeChain({
    text: post.text,
    topicTag: post.topic_tag,
    sourceUrl: post.source_url,
    followups: parts.map((p) => p.text),
  })
  const sentText = (i: number) => chain[i]?.text ?? ''
  // Every part of this chain went out after the post's slot came.
  const notBefore = post.scheduled_at
    ? new Date(post.scheduled_at.getTime() - RECOVERY_SKEW_MS)
    : null

  // Resolved lazily, inside a part's try: a missing token must be a failed attempt of that part
  // and not leave it stuck in PUBLISHING.
  let threads: ThreadsApi | undefined = api
  const getApi = async () => {
    threads ??= await getThreadsApi()
    return threads
  }

  let parent: Parent = {
    id: post.platform_post_id,
    text: sentText(0),
    repliesTo: null,
    label: `main post #${postId}`,
    save: async (id) => {
      await query(
        `update posts set platform_post_id = $2, updated_at = now()
         where id = $1 and status = 'PUBLISHED' and platform_post_id is null`,
        [postId, id],
      )
    },
  }
  const asParent = (
    part: PostPart,
    i: number,
    platformPostId: string | null,
    repliesTo: Parent,
  ): Parent => ({
    id: platformPostId,
    text: sentText(i + 1),
    repliesTo,
    label: `part ${part.idx} of #${postId}`,
    save: async (id) => {
      await query(
        `update post_parts set platform_post_id = $3, updated_at = now()
         where post_id = $1 and idx = $2 and status = 'PUBLISHED' and platform_post_id is null`,
        [postId, part.idx, id],
      )
    },
  })

  const publishParts = async (): Promise<ChainOutcome> => {
    let published = 0
    for (const [i, part] of parts.entries()) {
      if (part.status === 'PUBLISHED') {
        parent = asParent(part, i, part.platform_post_id, parent)
        continue
      }
      // FAILED waits for the owner's retry; PENDING/PUBLISHING are claimed below (a fresh
      // PUBLISHING part belongs to a live worker and the claim just fails).
      if (part.status === 'FAILED') return { kind: 'skipped' }

      const [claimed] = await query<{
        container_id: string | null
        attempts: number
        claim_seq: number
      }>(
        `update post_parts set status = 'PUBLISHING', attempts = attempts + 1,
         claim_seq = claim_seq + 1, updated_at = now()
       where post_id = $1 and idx = $2
         and (status = 'PENDING'
              or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $3)))
       returning container_id, attempts, claim_seq`,
        [postId, part.idx, STALE_PUBLISHING_MINUTES],
      )
      if (!claimed) return { kind: 'skipped' }

      // claim_seq is bumped by every claim and never reset, so it identifies this claim: if the
      // stale-claim sweep re-claimed the part, the token no longer matches and our writes must not
      // land. Ownership-checked update; false means the claim was lost. $1 = post, $2 = idx,
      // $3 = token, extras from $4.
      const token = claimed.claim_seq
      const ownedUpdate = async (set: string, params: unknown[] = []): Promise<boolean> => {
        const rows = await query(
          `update post_parts set ${set}, updated_at = now()
         where post_id = $1 and idx = $2 and status = 'PUBLISHING' and claim_seq = $3
         returning idx`,
          [postId, part.idx, token, ...params],
        )
        return rows.length > 0
      }

      let containerId = claimed.container_id
      try {
        const client = await getApi()
        const replyToId = await resolveParentId(client, parent, notBefore)
        const { platformPostId } = await driveContainer(
          client,
          { ...(chain[i + 1] ?? { text: part.text }), replyToId },
          claimed.container_id,
          async (id) => {
            containerId = id
            if (!(await ownedUpdate('container_id = $4', [id]))) throw new LostClaimError()
          },
          {
            // Doubles as a heartbeat: bumps updated_at so a slow but live worker is not reclaimed.
            beforePublish: async () => {
              if (!(await ownedUpdate('status = status'))) throw new LostClaimError()
            },
          },
        )
        // A null id means the container was already PUBLISHED (lost response). The part is live,
        // so recover its id when possible, but never fail a published part over the lookup: the
        // next part resolves it again when it actually needs it.
        let mediaId = platformPostId
        if (!mediaId) {
          mediaId = findMediaIdByText(
            await client.listMyReplies().catch(() => []),
            sentText(i + 1),
            {
              repliedToId: replyToId,
              notBefore,
            },
          )
        }
        if (
          !(await ownedUpdate(
            `status = 'PUBLISHED', platform_post_id = $4, published_at = now(), last_error = null`,
            [mediaId],
          ))
        ) {
          return { kind: 'skipped' }
        }
        published++
        parent = asParent(part, i, mediaId, parent)
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
        const decision = decideAfterFailure({ attempts: claimed.attempts, containerStatus })
        if (decision === 'published') {
          // The response was lost after Threads published; keep going, the id is resolved later.
          const saved = await ownedUpdate(
            `status = 'PUBLISHED', published_at = now(), last_error = null`,
          )
          if (!saved) return { kind: 'skipped' }
          published++
          parent = asParent(part, i, null, parent)
          continue
        }
        // Back to PENDING so the next sweep retries it; never leave the part PUBLISHING.
        const saved = await ownedUpdate(
          `status = '${decision === 'failed' ? 'FAILED' : 'PENDING'}', last_error = $4`,
          [error],
        )
        if (!saved) return { kind: 'skipped' }
        return decision === 'failed'
          ? { kind: 'failed', error, idx: part.idx }
          : { kind: 'retry', error }
      }
    }
    return { kind: 'done', published }
  }

  const outcome = await publishParts()
  // Only a following part ever looks up a missing media id, so the last published part (where
  // the chain ended or stopped) would keep an unknown id after a lost response, and its replies
  // would never be polled. Recovering it also recovers the parts before it. Best effort: while
  // an id is missing, dueChainPostIds brings the post back.
  if (parent.id === null && parent.repliesTo !== null) {
    try {
      await resolveParentId(await getApi(), parent, notBefore)
    } catch (err) {
      console.warn(`[publish-chain] #${postId}: ${(err as Error).message}`)
    }
  }
  return outcome
}
