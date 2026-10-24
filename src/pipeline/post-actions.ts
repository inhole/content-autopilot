import { query } from '../db/pool.ts'
import {
  applyReviewEdit,
  chainRetryText,
  publishNowText,
  regenText,
  rejectedText,
  unscheduledText,
} from '../review/telegram.ts'
import { addTopicFromUrl } from './add-topic.ts'
import { retryFailedParts } from './parts.ts'
import {
  approvePost,
  NotAwaitingReviewError,
  publishNow,
  rejectPost,
  unschedulePost,
} from './publish.ts'
import type { RejectReason } from './style.ts'

/**
 * Threads operations of the web console (docs/dashboard.md). Each one runs the same conditional
 * transition the Telegram button or reply runs, on the revision (or slot) the page displayed, and
 * then leaves Telegram in the state the equivalent press would have. A transition that does not
 * apply is `stale`; nothing is ever applied on an outdated view. Telegram is best effort: a
 * failure there is logged and reported in `telegramSynced`, never turned into a failed action.
 */

export type PostActionOutcome =
  | { ok: true; telegramSynced: boolean }
  | { ok: false; reason: 'not_found' | 'stale' | 'invalid'; message: string }

export type AddTopicOutcome =
  | { ok: true; topicId: number }
  | { ok: false; reason: 'covered'; postId: number; status: string }

export type PostActions = {
  approve(id: number, p: { revision: number }): Promise<PostActionOutcome>
  reject(id: number, p: { revision: number; reason: RejectReason }): Promise<PostActionOutcome>
  regenerate(id: number, p: { revision: number; feedback?: string }): Promise<PostActionOutcome>
  edit(id: number, p: { revision: number; idx: number; text: string }): Promise<PostActionOutcome>
  deletePart(id: number, p: { revision: number; idx: number }): Promise<PostActionOutcome>
  unschedule(id: number, p: { scheduledAt: Date }): Promise<PostActionOutcome>
  publishNow(id: number, p: { scheduledAt: Date }): Promise<PostActionOutcome>
  retryParts(id: number): Promise<PostActionOutcome>
  revive(id: number): Promise<PostActionOutcome>
  /** `url` must be a valid http(s) URL; the HTTP layer validates it before calling. */
  addTopic(p: { url: string; note?: string }): Promise<AddTopicOutcome>
  /** Queues revive-check (judging the expired drafts); the list goes to Telegram. */
  reviveCheck(): Promise<void>
  /** Queues weekly-digest now. */
  digest(): Promise<void>
}

/** What the worker hands over: the queues and the Telegram side live there. */
export type PostActionDeps = {
  /** Registers a regeneration (requestRegeneration) and queues it; false when nothing is under review. */
  enqueueRegeneration(topicId: number, feedback?: string): Promise<boolean>
  enqueueGenerate(topicId: number): Promise<void>
  enqueueRevive(postId: number): Promise<void>
  enqueueReviveCheck(): Promise<void>
  enqueueDigest(): Promise<void>
  /** The Telegram reviewer of the worker (src/review/telegram.ts). */
  reviewer: {
    sendForReview(postId: number): Promise<void>
    retireReviewMessages(postIds: number[]): Promise<void>
    notify(text: string): Promise<void>
    /** The `✅ 승인` confirmation with its ⏪/🚀 buttons bound to `at`. */
    notifyApproved(postId: number, at: Date): Promise<void>
  }
}

export const STALE_MESSAGE = '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요'

const stale = (message = STALE_MESSAGE): PostActionOutcome => ({
  ok: false,
  reason: 'stale',
  message,
})
const notFound = (): PostActionOutcome => ({ ok: false, reason: 'not_found', message: 'not found' })

/** Runs one Telegram step; a failure is logged and reported as false. */
async function bestEffort(label: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step()
    return true
  } catch (err) {
    console.error(`[post] web action: telegram ${label} failed`, (err as Error).message)
    return false
  }
}

type PostRow = {
  topic_id: number
  status: string
  revision: number
  origin: string | null
  revived_at: Date | null
  digest_post_id: number | null
}

const loadPost = async (id: number): Promise<PostRow | undefined> =>
  (
    await query<PostRow>(
      `select topic_id, status, revision, origin, revived_at, digest_post_id
       from posts where id = $1 and platform = 'THREADS'`,
      [id],
    )
  )[0]

export function createPostActions(deps: PostActionDeps): PostActions {
  const { reviewer } = deps

  /** Loads the post and checks the view the page had: PENDING_REVIEW at `revision`. */
  async function underReview(
    id: number,
    revision: number,
  ): Promise<{ post: PostRow } | { out: PostActionOutcome }> {
    const post = await loadPost(id)
    if (!post) return { out: notFound() }
    if (post.status !== 'PENDING_REVIEW' || post.revision !== revision) return { out: stale() }
    return { post }
  }

  /** The Telegram side of an applied edit: the changed draft goes out as a fresh review message. */
  async function afterEdit(
    id: number,
    result: Awaited<ReturnType<typeof applyReviewEdit>>,
  ): Promise<PostActionOutcome> {
    if (!result.ok) {
      return result.reason === 'stale'
        ? stale()
        : { ok: false, reason: 'invalid', message: result.message }
    }
    // sendForReview strips the keyboard of the previous review message itself.
    const ok = await bestEffort('edit', () => reviewer.sendForReview(id))
    return { ok: true, telegramSynced: ok }
  }

  return {
    async approve(id, { revision }) {
      const seen = await underReview(id, revision)
      if ('out' in seen) return seen.out
      let at: Date
      try {
        at = await approvePost(id, { revision })
      } catch (err) {
        if (err instanceof NotAwaitingReviewError) return stale()
        throw err
      }
      const ok = await bestEffort('approve', async () => {
        await reviewer.retireReviewMessages([id])
        await reviewer.notifyApproved(id, at)
      })
      return { ok: true, telegramSynced: ok }
    },

    async reject(id, { revision, reason }) {
      const seen = await underReview(id, revision)
      if ('out' in seen) return seen.out
      if (!(await rejectPost(id, reason, { revision }))) return stale()
      const ok = await bestEffort('reject', async () => {
        await reviewer.retireReviewMessages([id])
        await reviewer.notify(rejectedText(id, reason))
      })
      return { ok: true, telegramSynced: ok }
    },

    async regenerate(id, { revision, feedback }) {
      const seen = await underReview(id, revision)
      if ('out' in seen) return seen.out
      if (!(await deps.enqueueRegeneration(seen.post.topic_id, feedback?.trim() || undefined))) {
        return stale()
      }
      // The new review message arrives when the generate job finishes.
      const ok = await bestEffort('regenerate', async () => {
        await reviewer.retireReviewMessages([id])
        await reviewer.notify(regenText(id))
      })
      return { ok: true, telegramSynced: ok }
    },

    async edit(id, { revision, idx, text }) {
      const seen = await underReview(id, revision)
      if ('out' in seen) return seen.out
      const op = { kind: 'edit', idx, text: text.trim() } as const
      return afterEdit(id, await applyReviewEdit(id, { revision }, op))
    },

    async deletePart(id, { revision, idx }) {
      const seen = await underReview(id, revision)
      if ('out' in seen) return seen.out
      return afterEdit(id, await applyReviewEdit(id, { revision }, { kind: 'delete', idx }))
    },

    async unschedule(id, { scheduledAt }) {
      if (!(await loadPost(id))) return notFound()
      if (!(await unschedulePost(id, scheduledAt))) return stale()
      const noted = await bestEffort('unschedule', () => reviewer.notify(unscheduledText(id)))
      const sent = await bestEffort('unschedule review', () => reviewer.sendForReview(id))
      return { ok: true, telegramSynced: noted && sent }
    },

    async publishNow(id, { scheduledAt }) {
      if (!(await loadPost(id))) return notFound()
      if (!(await publishNow(id, scheduledAt))) return stale()
      const ok = await bestEffort('publish now', () => reviewer.notify(publishNowText(id)))
      return { ok: true, telegramSynced: ok }
    },

    async retryParts(id) {
      if (!(await loadPost(id))) return notFound()
      const count = await retryFailedParts(id)
      if (count === 0) return stale('다시 시도할 답글이 없어요')
      const ok = await bestEffort('retry parts', () => reviewer.notify(chainRetryText(id, count)))
      return { ok: true, telegramSynced: ok }
    },

    async revive(id) {
      const post = await loadPost(id)
      if (!post) return notFound()
      // The same set /revive lists (loadRevivable): expired news drafts not revived or digested.
      if (
        post.status !== 'EXPIRED' ||
        post.origin !== 'news' ||
        post.revived_at != null ||
        post.digest_post_id != null
      ) {
        return stale()
      }
      await deps.enqueueRevive(id)
      // The revive job sends the review message itself.
      return { ok: true, telegramSynced: true }
    },

    async addTopic({ url, note }) {
      const added = await addTopicFromUrl(url, note?.trim() || undefined)
      if ('covered' in added) {
        return {
          ok: false,
          reason: 'covered',
          postId: added.covered.postId,
          status: added.covered.status,
        }
      }
      await deps.enqueueGenerate(added.topicId)
      return { ok: true, topicId: added.topicId }
    },

    async reviveCheck() {
      await deps.enqueueReviveCheck()
    },

    async digest() {
      await deps.enqueueDigest()
    },
  }
}
