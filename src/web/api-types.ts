/**
 * JSON contract of the dashboard API (`/api/*`, src/web/api.ts) shared with the React app in
 * `web/` (imported there with `import type`, so nothing here may have runtime code the app needs).
 * Dates travel as ISO 8601 strings. Data routes are GET-only and need a login session (the auth
 * routes at the end); without one they answer 401.
 */
import type {
  Campaign,
  CampaignRejectReason,
  CampaignSource,
  CampaignStatus,
} from '../campaigns/types.ts'
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
    /** Applicants per slot; null when unknown. */
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

/**
 * GET /api/auth/session, and the body of a successful POST /api/auth/login. The CSRF token goes
 * back in the `X-CSRF-Token` header of every state-changing request.
 */
export type AuthSessionResponse =
  | { authenticated: true; csrf: string; expiresAt: string }
  | { authenticated: false }

/** POST /api/auth/code: the code went to Telegram. 429 `{ error, retryAfter }` when rate limited. */
export type AuthCodeResponse = { expiresAt: string }

/**
 * POST /api/campaigns/:id/<action>: campaign operations (docs/dashboard.md). Every request needs
 * the session cookie, a same-origin JSON body and the `X-CSRF-Token` header. The body carries the
 * `revision` (and `status`) of the campaign the page displayed, so an outdated view changes
 * nothing: 409 `CampaignActionConflict`. 404 unknown campaign, 400 invalid body.
 */
export type CampaignActionRequests = {
  /** ✅ 신청함 (PENDING_REVIEW) */
  apply: { revision: number }
  /** 🙅 패스 (PENDING_REVIEW) */
  reject: { revision: number; reason: CampaignRejectReason }
  /** 🎉 선정 / 😢 미선정 (APPLIED) */
  result: { selected: boolean }
  /** Review deadline: end of that KST day. `date` takes the formats of Telegram /due. */
  deadline: { status: CampaignStatus; date: string }
  /** The owner's notes; queues the review draft (SELECTED / DRAFT_REVIEW). */
  memo: { status: CampaignStatus; revision: number; memo: string }
  /** 🔁 다시 쓰기 with optional feedback (DRAFT_REVIEW) */
  regenerate: { revision: number; feedback?: string }
  /** Replaces the draft verbatim, like `수정:` (DRAFT_REVIEW) */
  draft: { revision: number; text: string }
  /** ✅ 리뷰 올림 (DRAFT_REVIEW) */
  posted: { revision: number }
}
export type CampaignActionName = keyof CampaignActionRequests

/** 200: the action applied; `detail` is the campaign as it is now (null if it vanished). */
export type CampaignActionResponse = {
  ok: true
  /** False when the Telegram card could not be updated (logged; the action itself applied). */
  telegramSynced: boolean
  detail: CampaignDetailResponse | null
}

/** 409: the campaign changed since the page showed it, or was already handled. */
export type CampaignActionConflict = ApiError & { stale: true }
