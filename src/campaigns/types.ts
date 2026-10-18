import { z } from 'zod'

/** Mirrors the check constraint in migrations/014_campaigns.sql. */
export const CAMPAIGN_STATUSES = [
  'COLLECTED',
  'SKIPPED',
  'SHORTLISTED',
  'PENDING_REVIEW',
  'REJECTED',
  'EXPIRED',
  'APPLIED',
  'SELECTED',
  'NOT_SELECTED',
  'DRAFT_REVIEW',
  'POSTED',
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

/** Statuses still in progress (shown by /camps and the dashboard's default list). */
export const ACTIVE_CAMPAIGN_STATUSES = [
  'PENDING_REVIEW',
  'APPLIED',
  'SELECTED',
  'DRAFT_REVIEW',
] as const satisfies readonly CampaignStatus[]

/**
 * Where a campaign comes from (`campaigns.source`). Kakao gift only gives remaining days, so its
 * apply deadline is an estimate; Musinsa gives the exact end time.
 */
export const CAMPAIGN_SOURCES = {
  'kakao-gift': {
    label: '선물하기',
    applyOn: 'mobile',
    reviewPlace: '선물하기 상품 리뷰',
    estimatedDeadline: true,
  },
  musinsa: {
    label: '무신사',
    applyOn: 'pc',
    reviewPlace: '무신사 상품 후기',
    estimatedDeadline: false,
  },
} as const
export type CampaignSource = keyof typeof CAMPAIGN_SOURCES
export const CAMPAIGN_SOURCE_KEYS = Object.keys(CAMPAIGN_SOURCES) as CampaignSource[]

export function isCampaignSource(value: unknown): value is CampaignSource {
  return typeof value === 'string' && Object.hasOwn(CAMPAIGN_SOURCES, value)
}

/** Source facts for a stored `source` string; unknown values fall back to the Kakao gift wording. */
export function sourceInfo(source: string | null | undefined) {
  return CAMPAIGN_SOURCES[isCampaignSource(source) ? source : 'kakao-gift']
}

/** One item of the Musinsa preuser recruitment list (src/campaigns/musinsa.ts), the fields we read. */
export type MusinsaDetail = {
  campaignId?: number | string
  campaignEndDate?: string
  brandName?: string
  representativeGoods?: { goodsImageUrl?: string; goodsName?: string; price?: number | null } | null
  goodsCount?: number | null
  contentType?: string | null
}

export type ContentType = 'VIDEO' | 'IMAGE'

/** Reads the Musinsa-only facts out of `campaigns.detail`; null for any other source. */
export function musinsaFacts(c: Pick<Campaign, 'source' | 'detail'>): {
  price: number | null
  goodsCount: number | null
  contentType: ContentType | null
} | null {
  if (c.source !== 'musinsa') return null
  const d = (c.detail ?? {}) as MusinsaDetail
  const price = d.representativeGoods?.price
  const contentType = d.contentType === 'VIDEO' || d.contentType === 'IMAGE' ? d.contentType : null
  return {
    price: typeof price === 'number' ? price : null,
    goodsCount: typeof d.goodsCount === 'number' ? d.goodsCount : null,
    contentType,
  }
}

/** One `campaigns` row as selected with `select *`. */
export type Campaign = {
  id: number
  source: string
  external_id: string
  url: string
  url_hash: string
  status: CampaignStatus
  title: string
  brand: string | null
  product_id: number | null
  image_url: string | null
  recruit_count: number | null
  application_count: number | null
  remaining_days: number | null
  apply_deadline: Date | null
  first_seen_at: Date
  last_seen_at: Date
  detail: GiftTrialItem | MusinsaDetail | null
  score: number | null
  reason: string | null
  /** When the ranker picked it (migration 015); the daily pick quota counts this. */
  shortlisted_at: Date | null
  skip_reason: string | null
  revision: number
  review_chat_id: number | null
  review_message_id: number | null
  review_revision: number | null
  reject_reason: string | null
  applied_at: Date | null
  selected_at: Date | null
  result_at: Date | null
  review_deadline: Date | null
  intake_message_id: number | null
  memo: string | null
  draft_text: string | null
  regen_seq: number
  posted_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * One item of the public Kakao gift trial-campaign list (src/campaigns/gift.ts). Verified against
 * gift.kakao.com on 2026-10-18; unknown extra fields are kept by passthrough.
 */
export const giftTrialItemSchema = z
  .object({
    campaignId: z.string().min(1),
    campaignTitle: z.string(),
    brand: z.object({ id: z.union([z.string(), z.number()]), name: z.string() }).nullish(),
    imageUrl: z.string().nullish(),
    productId: z.number().int().nullish(),
    remainingDays: z.number().int().nullish(),
    recruitmentCount: z.number().int().nullish(),
    applicationCount: z.number().int().nullish(),
  })
  .passthrough()
export type GiftTrialItem = z.infer<typeof giftTrialItemSchema>

/** Applicants per slot, or null when either count is unknown. */
export function competition(c: Pick<Campaign, 'application_count' | 'recruit_count'>) {
  if (c.application_count == null || !c.recruit_count) return null
  return c.application_count / c.recruit_count
}

export const CAMPAIGN_REJECT_REASONS = {
  category: '관심 없는 품목',
  competition: '경쟁률이 너무 높음',
  brand: '브랜드·품질이 불안함',
  other: '기타',
} as const
export type CampaignRejectReason = keyof typeof CAMPAIGN_REJECT_REASONS

export function isCampaignRejectReason(value: string): value is CampaignRejectReason {
  return Object.hasOwn(CAMPAIGN_REJECT_REASONS, value)
}
