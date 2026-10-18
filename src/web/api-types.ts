/**
 * JSON contract of the dashboard API (`/api/*`, src/web/api.ts) shared with the React app in
 * `web/` (imported there with `import type`, so nothing here may have runtime code the app needs).
 * Dates travel as ISO 8601 strings. Every route is GET-only and behind the same Basic auth as the
 * rest of the dashboard.
 */
import type { Campaign, CampaignSource, CampaignStatus } from '../campaigns/types.ts'
import type { CampaignListRow, OverviewData, PostRow } from './data.ts'

/** `Date` → ISO string, recursively; everything else as is. */
export type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T

/** GET /api/overview */
export type OverviewResponse = Jsonify<OverviewData>

/** GET /api/campaigns?status=active|all|<STATUS>&source=kakao-gift|musinsa */
export type CampaignListResponse = {
  filter: { status: CampaignStatus | 'active' | 'all'; source: CampaignSource | null }
  rows: (Jsonify<CampaignListRow> & {
    /** Deadline of the current stage (see nextDeadline in data.ts); null when it has none. */
    next_deadline: { at: string; kind: 'apply' | 'review'; estimated: boolean } | null
    /** Applicants per slot; null when unknown (always null for Musinsa). */
    competition: number | null
  })[]
}

/** GET /api/campaigns/:id (404 `{ error }` when unknown) */
export type CampaignDetailResponse = {
  campaign: Jsonify<Campaign>
  reminders: { kind: string; sent_at: string }[]
}

/** GET /api/posts?limit=50 (max 200) */
export type PostListResponse = {
  rows: (Jsonify<PostRow> & { origin: 'news' | 'revived' | 'digest' })[]
}

/**
 * GET /api/insights?days=30 (7..90). Threads engagement of published posts: `daily` sums each
 * post's latest snapshot by its KST publish day; `top` is the posts with the most views in the
 * window. Null metrics (Threads returned none) count as zero in sums.
 */
export type InsightsResponse = {
  days: number
  daily: { date: string; posts: number; views: number; likes: number; replies: number }[]
  top: {
    id: number
    text: string
    published_at: string
    views: number | null
    likes: number | null
    replies: number | null
    reposts: number | null
  }[]
}

/** Error body of any non-2xx JSON response. */
export type ApiError = { error: string }
