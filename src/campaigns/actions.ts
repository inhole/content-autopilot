import { markApplied, markResult, rejectCampaign, setReviewDeadline } from './review.ts'
import { type DraftGuard, markPosted, replaceDraftGuarded, saveMemo } from './review-draft.ts'
import { postedText, sendDraft } from './review-telegram.ts'
import { loadCampaign } from './store.ts'
import {
  appliedText,
  draftStartButtons,
  notSelectedText,
  passedText,
  resultButtons,
  selectedText,
} from './telegram.ts'
import { clearButtons, sendCampaignMessage } from './tg.ts'
import type { Campaign, CampaignRejectReason, CampaignStatus } from './types.ts'

/**
 * Campaign operations of the web console (docs/dashboard.md). Each one runs the same conditional
 * transition the Telegram button runs, on the revision (and status) the page displayed, and then
 * leaves the Telegram card in the state the equivalent press would have. A transition that does
 * not apply is `stale`; nothing is ever applied on an outdated view. Telegram is best effort: a
 * failure there is logged and reported in `telegramSynced`, never turned into a failed action.
 */

export const STALE_MESSAGE = '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요'

export type ActionOutcome =
  | { ok: true; telegramSynced: boolean }
  | { ok: false; reason: 'not_found' | 'stale' | 'invalid'; message: string }

export type CampaignActions = {
  apply(id: number, p: { revision: number }): Promise<ActionOutcome>
  reject(id: number, p: { revision: number; reason: CampaignRejectReason }): Promise<ActionOutcome>
  result(id: number, p: { selected: boolean }): Promise<ActionOutcome>
  deadline(id: number, p: { status: CampaignStatus; deadline: Date }): Promise<ActionOutcome>
  memo(
    id: number,
    p: { status: CampaignStatus; revision: number; memo: string },
  ): Promise<ActionOutcome>
  regenerate(id: number, p: { revision: number; feedback?: string }): Promise<ActionOutcome>
  draft(id: number, p: { revision: number; text: string }): Promise<ActionOutcome>
  posted(id: number, p: { revision: number }): Promise<ActionOutcome>
}

export type CampaignActionDeps = {
  /**
   * Registers a draft request (requestDraftRegeneration) and queues the review-draft job. False
   * when the campaign is not at the stage of writing a review (or `revision` moved on).
   */
  enqueueDraft(id: number, feedback?: string, revision?: number): Promise<boolean>
}

const stale = (): ActionOutcome => ({ ok: false, reason: 'stale', message: STALE_MESSAGE })
const invalid = (message: string): ActionOutcome => ({ ok: false, reason: 'invalid', message })
const notFound = (): ActionOutcome => ({ ok: false, reason: 'not_found', message: 'not found' })

/** Runs one Telegram step; a failure is logged and reported as false. */
async function bestEffort(label: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step()
    return true
  } catch (err) {
    console.error(`[campaign] web action: telegram ${label} failed`, (err as Error).message)
    return false
  }
}

/** The old card or control message loses its keyboard, like the press that was not made there. */
const stripKeyboard = (c: Pick<Campaign, 'review_chat_id' | 'review_message_id'>) =>
  c.review_chat_id != null && c.review_message_id != null
    ? clearButtons(c.review_chat_id, c.review_message_id)
    : Promise.resolve()

type Seen = { c: Campaign } | { out: ActionOutcome }

/** Loads the campaign and checks the view the page had: its status and, if given, revision. */
async function current(
  id: number,
  statuses: readonly CampaignStatus[],
  revision?: number,
): Promise<Seen> {
  const c = await loadCampaign(id)
  if (!c) return { out: notFound() }
  if (!statuses.includes(c.status) || (revision != null && c.revision !== revision)) {
    return { out: stale() }
  }
  return { c }
}

export function createCampaignActions(deps: CampaignActionDeps): CampaignActions {
  return {
    async apply(id, { revision }) {
      const seen = await current(id, ['PENDING_REVIEW'], revision)
      if ('out' in seen) return seen.out
      if (!(await markApplied(id, revision))) return stale()
      const ok = await bestEffort('apply', async () => {
        await stripKeyboard(seen.c)
        await sendCampaignMessage(appliedText(id), resultButtons(id))
      })
      return { ok: true, telegramSynced: ok }
    },

    async reject(id, { revision, reason }) {
      const seen = await current(id, ['PENDING_REVIEW'], revision)
      if ('out' in seen) return seen.out
      if (!(await rejectCampaign(id, revision, reason))) return stale()
      const ok = await bestEffort('reject', async () => {
        await stripKeyboard(seen.c)
        await sendCampaignMessage(passedText(id, reason))
      })
      return { ok: true, telegramSynced: ok }
    },

    async result(id, { selected }) {
      const seen = await current(id, ['APPLIED'])
      if ('out' in seen) return seen.out
      if (!(await markResult(id, selected))) return stale()
      // The result-button message is not tracked, so its keyboard stays; pressing it later only
      // answers "already handled" because these transitions are gated by status.
      const ok = await bestEffort('result', async () => {
        if (selected) await sendCampaignMessage(selectedText(id), draftStartButtons(id))
        else await sendCampaignMessage(notSelectedText(id))
      })
      return { ok: true, telegramSynced: ok }
    },

    async deadline(id, { status, deadline }) {
      const seen = await current(id, [status])
      if ('out' in seen) return seen.out
      if (!(await setReviewDeadline(id, deadline))) return stale()
      return { ok: true, telegramSynced: true }
    },

    async memo(id, { status, revision, memo }) {
      if (status !== 'SELECTED' && status !== 'DRAFT_REVIEW') return stale()
      const seen = await current(id, [status], revision)
      if ('out' in seen) return seen.out
      if (!memo.trim()) return invalid('메모가 비어 있어요. 써본 느낌을 몇 줄 적어주세요.')
      // Both steps are bound to the displayed status and revision: a draft written or edited in
      // the meantime makes this request stale instead of regenerating over it.
      if (!(await saveMemo(id, memo, { status, revision }))) return stale()
      // The job sends the draft and the control message to Telegram when it is written.
      if (!(await deps.enqueueDraft(id, undefined, revision))) return stale()
      return { ok: true, telegramSynced: true }
    },

    async regenerate(id, { revision, feedback }) {
      const seen = await current(id, ['DRAFT_REVIEW'], revision)
      if ('out' in seen) return seen.out
      if (!(await deps.enqueueDraft(id, feedback?.trim() || undefined, revision))) return stale()
      return { ok: true, telegramSynced: true }
    },

    async draft(id, { revision, text }) {
      const seen = await current(id, ['DRAFT_REVIEW'], revision)
      if ('out' in seen) return seen.out
      const guard: DraftGuard = { revision }
      const res = await replaceDraftGuarded(id, guard, text)
      if (!res.ok) return res.stale ? stale() : invalid(res.message)
      // Same as a `수정:` reply: the new draft and a fresh control message go out.
      const ok = await bestEffort('draft', () => sendDraft(id))
      return { ok: true, telegramSynced: ok }
    },

    async posted(id, { revision }) {
      const seen = await current(id, ['DRAFT_REVIEW'], revision)
      if ('out' in seen) return seen.out
      if (!(await markPosted(id, revision, { control: false }))) return stale()
      const ok = await bestEffort('posted', async () => {
        await stripKeyboard(seen.c)
        await sendCampaignMessage(postedText(id))
      })
      return { ok: true, telegramSynced: ok }
    },
  }
}
