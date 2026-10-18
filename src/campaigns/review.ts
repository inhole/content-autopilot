import { query } from '../db/pool.ts'
import {
  ACTIVE_CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignRejectReason,
  type CampaignStatus,
} from './types.ts'

/**
 * State transitions of the Telegram card (docs/plans/campaign-autopilot.md). Every one is a
 * conditional UPDATE that reports whether it applied, so a stale button, a double press or a
 * racing edit changes nothing. Owner-facing transitions require that the card the owner saw is
 * still current: `revision = review_revision = <revision pressed>`.
 */

const CURRENT_CARD = "status = 'PENDING_REVIEW' and revision = $2 and review_revision = $2"

/** Registers a freshly sent card, only if the revision it shows is still current. */
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

/** The owner applied in the KakaoTalk app by hand. */
export async function markApplied(id: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'APPLIED', applied_at = now(), updated_at = now()
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

/** Records the owner-reported result of an application. Gated by status alone. */
export async function markResult(id: number, selected: boolean): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = $2,
       selected_at = case when $2 = 'SELECTED' then now() else selected_at end,
       result_at = now(), updated_at = now()
     where id = $1 and status = 'APPLIED' returning id`,
    [id, selected ? 'SELECTED' : 'NOT_SELECTED'],
  )
  return rows.length > 0
}

/** Sets the review deadline given by the owner with /due. */
export async function setReviewDeadline(id: number, deadline: Date): Promise<boolean> {
  const rows = await query(
    `update campaigns set review_deadline = $2, updated_at = now()
     where id = $1 and status in ('APPLIED', 'SELECTED', 'DRAFT_REVIEW') returning id`,
    [id, deadline],
  )
  return rows.length > 0
}

export type ExpiredCard = {
  id: number
  review_chat_id: number | null
  review_message_id: number | null
}

/** Campaigns whose application window closed. The caller strips their keyboards. */
export async function expireCampaigns(now: Date): Promise<ExpiredCard[]> {
  return query<ExpiredCard>(
    `update campaigns set status = 'EXPIRED', updated_at = now()
     where status in ('COLLECTED', 'SHORTLISTED', 'PENDING_REVIEW') and apply_deadline < $1
     returning id, review_chat_id, review_message_id`,
    [now],
  )
}

/** Campaigns still in progress, ordered by the date that matters next (nulls last). */
export async function loadActiveCampaigns(): Promise<Campaign[]> {
  return query<Campaign>(
    `select * from campaigns
     where status = any($1::text[])
     order by case
         when status in ('PENDING_REVIEW', 'APPLIED') then apply_deadline
         else review_deadline
       end asc nulls last, id`,
    [[...ACTIVE_CAMPAIGN_STATUSES] satisfies CampaignStatus[]],
  )
}
