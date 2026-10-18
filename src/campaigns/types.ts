import { z } from 'zod'

/** Mirrors the check constraint in migrations/014_campaigns.sql. */
export const CAMPAIGN_STATUSES = [
  'DISCOVERED',
  'DETAILED',
  'UNREADABLE',
  'SKIPPED',
  'SHORTLISTED',
  'PENDING_REVIEW',
  'REJECTED',
  'EXPIRED',
  'APPROVED',
  'APPLYING',
  'APPLIED',
  'APPLY_FAILED',
  'SELECTED',
  'NOT_SELECTED',
  'RECEIVED',
  'DRAFT_REVIEW',
  'DRAFT_APPROVED',
  'DRAFT_SAVING',
  'DRAFT_SAVED',
  'DRAFT_FAILED',
  'POSTED',
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export type CampaignType = 'delivery' | 'visit' | 'other'

/** A claimed step (apply, blog save) gives up after this many attempts. */
export const MAX_CLAIM_ATTEMPTS = 3
/** A claimed row untouched this long is treated as crashed and may be claimed again. */
export const STALE_CLAIM_MINUTES = 10

/** One `campaigns` row as selected with `select *`. */
export type Campaign = {
  id: number
  source: string
  external_id: string
  url: string
  url_hash: string
  found_in: string | null
  status: CampaignStatus
  title: string | null
  type: CampaignType | null
  category: string | null
  reward_won: number | null
  recruit_count: number | null
  apply_deadline: Date | null
  announce_at: Date | null
  review_deadline: Date | null
  keywords: string[]
  detail: CampaignDetail | null
  score: number | null
  reason: string | null
  skip_reason: string | null
  apply_message: string | null
  revision: number
  review_chat_id: number | null
  review_message_id: number | null
  review_revision: number | null
  reject_reason: string | null
  claim_seq: number
  attempts: number
  last_error: string | null
  screenshot_path: string | null
  applied_at: Date | null
  selected_at: Date | null
  received_at: Date | null
  intake_message_id: number | null
  memo: string | null
  draft_title: string | null
  draft_body: string | null
  regen_seq: number
  draft_saved_at: Date | null
  blog_url: string | null
  posted_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * Structured campaign detail extracted from a revu page by the LLM (src/campaigns/revu.ts).
 * Dates are ISO 8601 strings with a +09:00 offset; null when the page does not say.
 */
export const campaignDetailSchema = z.object({
  title: z.string(),
  type: z.enum(['delivery', 'visit', 'other']),
  category: z.string().nullable(),
  /** What the reviewer receives, e.g. "무선 이어폰 1개 (정가 59,000원)". */
  offer: z.string(),
  rewardWon: z.number().int().nullable(),
  recruitCount: z.number().int().nullable(),
  applyDeadline: z.string().nullable(),
  announceAt: z.string().nullable(),
  reviewDeadline: z.string().nullable(),
  /** Channel the review must be posted on, e.g. "네이버 블로그". */
  channel: z.string().nullable(),
  keywords: z.array(z.string()),
  /** Mission and guide text the review must follow, condensed. */
  guide: z.string(),
  /** Questions or fields the application form asks for, if the page shows them. */
  applyQuestions: z.array(z.string()),
})
export type CampaignDetail = z.infer<typeof campaignDetailSchema>

export const CAMPAIGN_REJECT_REASONS = {
  category: '관심 없는 품목',
  reward: '제공 가치가 낮음',
  brand: '브랜드·품질이 불안함',
  schedule: '일정이 안 맞음',
  other: '기타',
} as const
export type CampaignRejectReason = keyof typeof CAMPAIGN_REJECT_REASONS

export function isCampaignRejectReason(value: string): value is CampaignRejectReason {
  return Object.hasOwn(CAMPAIGN_REJECT_REASONS, value)
}
