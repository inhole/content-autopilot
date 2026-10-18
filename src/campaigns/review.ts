import { query } from '../db/pool.ts'
import { loadCampaignProfile } from './profile.ts'
import type { Campaign, CampaignRejectReason } from './types.ts'

/**
 * State transitions of the Telegram card (docs/plans/campaign-autopilot.md). Every one is a
 * conditional UPDATE that reports whether it applied, so a stale button, a double press or a
 * racing edit changes nothing. Owner-facing transitions require that the card the owner saw is
 * still current: `revision = review_revision = <revision pressed>`.
 */

const CURRENT_CARD = "status = 'PENDING_REVIEW' and revision = $2 and review_revision = $2"

/** Registers a freshly sent card, only if the apply message is still the revision it shows. */
export async function markCardSent(
  id: number,
  chatId: number,
  messageId: number,
  revision: number,
): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'PENDING_REVIEW', review_chat_id = $2, review_message_id = $3,
       review_revision = $4, updated_at = now()
     where id = $1 and revision = $4 and status in ('SHORTLISTED', 'PENDING_REVIEW')
     returning id`,
    [id, chatId, messageId, revision],
  )
  return rows.length > 0
}

/** The owner applied on revu by hand. */
export async function markAppliedManually(id: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'APPLIED', applied_at = now(), updated_at = now()
     where id = $1 and ${CURRENT_CARD} returning id`,
    [id, revision],
  )
  return rows.length > 0
}

/** The owner approved an automatic application; the local worker (Aside) submits it. */
export async function approveApply(id: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'APPROVED', attempts = 0, last_error = null, updated_at = now()
     where id = $1 and ${CURRENT_CARD} returning id`,
    [id, revision],
  )
  return rows.length > 0
}

export async function rejectCampaign(
  id: number,
  revision: number,
  reason: CampaignRejectReason,
): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'REJECTED', reject_reason = $3, updated_at = now()
     where id = $1 and ${CURRENT_CARD} returning id`,
    [id, revision, reason],
  )
  return rows.length > 0
}

export type ReplaceApplyMessageResult =
  | { ok: true; revision: number }
  | { ok: false; message: string }

/**
 * Replaces the apply message verbatim (a `수정:` reply). Bound to the card the reply was sent to;
 * bumps revision so the old card's buttons stop working until the new card is sent.
 */
export async function replaceApplyMessage(
  id: number,
  reviewMessageId: number,
  text: string,
  maxChars?: number,
): Promise<ReplaceApplyMessageResult> {
  const next = text.trim()
  if (!next) {
    return { ok: false, message: '신청 메시지가 비어 있어요. 수정: 뒤에 내용을 적어주세요.' }
  }
  const max = maxChars ?? (await loadCampaignProfile()).applyMessage.maxChars
  const length = [...next].length
  if (length > max) {
    return { ok: false, message: `신청 메시지가 ${length}자예요. ${max}자 이하로 줄여주세요.` }
  }
  const rows = await query<{ revision: number }>(
    `update campaigns set apply_message = $3, revision = revision + 1, updated_at = now()
     where id = $1 and status = 'PENDING_REVIEW' and review_message_id = $2
     returning revision`,
    [id, reviewMessageId, next],
  )
  const row = rows[0]
  if (!row) return { ok: false, message: '이미 처리됐거나 최신 카드가 아니에요.' }
  return { ok: true, revision: row.revision }
}

/** Retry after a failed application. Not bound to a revision: the owner did not edit anything. */
export async function retryApply(id: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'APPROVED', attempts = 0, last_error = null, updated_at = now()
     where id = $1 and status = 'APPLY_FAILED' returning id`,
    [id],
  )
  return rows.length > 0
}

export type ExpiredCard = {
  id: number
  review_chat_id: number | null
  review_message_id: number | null
}

/** Cards whose application window closed. The caller strips their keyboards. */
export async function expirePastDeadline(now: Date): Promise<ExpiredCard[]> {
  return query<ExpiredCard>(
    `update campaigns set status = 'EXPIRED', updated_at = now()
     where status in ('PENDING_REVIEW', 'SHORTLISTED') and apply_deadline < $1
     returning id, review_chat_id, review_message_id`,
    [now],
  )
}

/** Campaigns still in progress (for /camps), ordered by the deadline that matters next. */
export async function loadActiveCampaigns(): Promise<Campaign[]> {
  return query<Campaign>(
    `select * from campaigns
     where status in ('PENDING_REVIEW', 'APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED',
       'SELECTED', 'RECEIVED', 'DRAFT_REVIEW', 'DRAFT_APPROVED', 'DRAFT_SAVING', 'DRAFT_SAVED',
       'DRAFT_FAILED')
     order by coalesce(
       case
         when status in ('PENDING_REVIEW', 'APPROVED', 'APPLYING', 'APPLY_FAILED') then apply_deadline
         when status = 'APPLIED' then announce_at
         else review_deadline
       end, 'infinity'::timestamptz), id`,
  )
}
