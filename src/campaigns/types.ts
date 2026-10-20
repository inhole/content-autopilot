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
 * apply deadline is an estimate; Musinsa gives the exact end date.
 */
export const CAMPAIGN_SOURCES = {
  'kakao-gift': {
    label: '카카오톡',
    applyOn: 'mobile',
    reviewPlace: '카카오톡 선물하기 상품 리뷰',
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

/** Korean names of the Musinsa preuser categories (ids of `/event/filters`); others show the raw id. */
export const MUSINSA_CATEGORY_LABELS: Record<string, string> = {
  BEAUTY: '뷰티',
  SHOE: '신발',
  TOP: '상의',
  OUTER: '아우터',
  PANTS: '바지',
  DRESS_AND_SKIRT: '원피스/스커트',
  BAG: '가방',
  FASHION_ACCESSORY: '패션 소품',
  UNDERWEAR: '속옷/홈웨어',
  SPORTS: '스포츠/레저',
  DIGITAL_LIFE: '디지털/라이프',
  KIDS: '키즈',
}

export const musinsaCategoryLabel = (id: string) => MUSINSA_CATEGORY_LABELS[id] ?? id

/**
 * `campaigns.detail` of a Musinsa row: one list item of /preuser/api/v1/event/events (the fields
 * we read), plus the fields of /event/events/:id that are fetched once for new rows
 * (src/campaigns/musinsa.ts).
 */
export type MusinsaDetail = {
  id?: number
  type?: string
  endDate?: string
  products?: {
    uniqueId?: string | number
    isRepresentative?: boolean | null
    prices?: {
      normalPrice?: { value?: number | null } | null
      salePrice?: { value?: number | null } | null
    } | null
  }[]
  eventCategory?: string | null
  winnerDrawDate?: string | null
  deliveryDate?: string | null
  reviewStartDate?: string | null
  reviewEndDate?: string | null
  minimumMemberLevel?: number | null
  optionNames?: string[]
}

export type MusinsaFacts = {
  /** Representative product's list price in won. */
  price: number | null
  /** Sale price in won, only when it is lower than the list price. */
  salePrice: number | null
  goodsCount: number | null
  /** Raw category id (e.g. FASHION_ACCESSORY); see musinsaCategoryLabel. */
  category: string | null
  /** YYYY-MM-DD strings from the detail endpoint. */
  winnerDrawDate: string | null
  deliveryDate: string | null
  reviewStartDate: string | null
  reviewEndDate: string | null
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** Reads the Musinsa-only facts out of `campaigns.detail`; null for any other source. */
export function musinsaFacts(c: Pick<Campaign, 'source' | 'detail'>): MusinsaFacts | null {
  if (c.source !== 'musinsa') return null
  const d = (c.detail ?? {}) as MusinsaDetail
  const products = Array.isArray(d.products) ? d.products : []
  const rep = products.find((p) => p?.isRepresentative) ?? products[0]
  const normal = rep?.prices?.normalPrice?.value
  const sale = rep?.prices?.salePrice?.value
  const price = typeof normal === 'number' ? normal : null
  return {
    price,
    salePrice: typeof sale === 'number' && price !== null && sale < price ? sale : null,
    goodsCount: products.length || null,
    category: str(d.eventCategory),
    winnerDrawDate: str(d.winnerDrawDate),
    deliveryDate: str(d.deliveryDate),
    reviewStartDate: str(d.reviewStartDate),
    reviewEndDate: str(d.reviewEndDate),
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
  detail: (GiftTrialItem & { price?: GiftPrice | null }) | MusinsaDetail | null
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

/** Gift product price in won, stored by the collector in `campaigns.detail.price`. */
export type GiftPrice = { basic: number | null; selling: number | null }

export type CampaignPriceInfo = {
  /** List price (정가) in won; null when unknown. */
  price: number | null
  /** Lower selling/sale price in won, only when it is below the list price. */
  salePrice: number | null
}

const wonOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** Price facts of any source: Musinsa representative product, Kakao gift `detail.price`. */
export function campaignPriceInfo(c: { source?: string; detail?: unknown }): CampaignPriceInfo {
  const m = musinsaFacts({ source: c.source ?? '', detail: c.detail as Campaign['detail'] })
  if (m) return { price: m.price, salePrice: m.salePrice }
  const raw = (c.detail as { price?: { basic?: unknown; selling?: unknown } | null } | null)?.price
  const selling = wonOrNull(raw?.selling)
  const price = wonOrNull(raw?.basic) ?? selling
  return {
    price,
    salePrice: selling !== null && price !== null && selling < price ? selling : null,
  }
}

/** The normal price (정가) in won, or null when unknown. */
export const campaignPrice = (c: { source?: string; detail?: unknown }): number | null =>
  campaignPriceInfo(c).price

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
