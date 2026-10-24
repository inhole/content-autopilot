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

export function createPostActions(_deps: PostActionDeps): PostActions {
  throw new Error('not implemented')
}
