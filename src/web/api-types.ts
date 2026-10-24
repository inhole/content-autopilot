/**
 * JSON contract of the dashboard API (`/api/*`, src/web/api.ts) shared with the React app in
 * `web/` (imported there with `import type`, so nothing here may have runtime code the app needs).
 * Dates travel as ISO 8601 strings. Data routes are GET-only and need a login session (the auth
 * routes and the campaign actions at the end); without one they answer 401.
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

/** posts.status */
export type PostStatus =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED'

/** Codes of the 🗑 폐기 reasons (REJECT_REASONS in src/pipeline/style.ts). */
export type PostRejectReason = 'fact' | 'boring' | 'topic' | 'dup' | 'other'

/** GET /api/posts/:id (404 `{ error }` when unknown). Everything the post panel shows and sends back. */
export type PostDetailResponse = {
  post: {
    id: number
    status: PostStatus
    origin: 'news' | 'revived' | 'digest'
    /** Part 1 (the main post). */
    text: string
    angle: string | null
    source_url: string | null
    /** generation.caveats ("확인 필요"). */
    caveats: string[]
    /** Bumped by every text change; actions on a draft send back the one displayed. */
    revision: number
    /** Bumped when a regeneration is requested (posts.regen_seq). */
    regen_seq: number
    scheduled_at: string | null
    published_at: string | null
    created_at: string
    updated_at: string
    reject_reason: PostRejectReason | null
    attempts: number
    last_error: string | null
    topic: {
      id: number
      title: string
      url: string | null
      note: string | null
      score: number | null
    }
    /** Expired-draft judgement and revival (migration 016); null fields when never judged. */
    revive: {
      verdict: 'evergreen' | 'stale' | null
      reason: string | null
      checked_at: string | null
      revived_at: string | null
      /** The text before the revival rewrite (generation.revived.from_text). */
      from_text: string | null
    }
    /** Digest this expired draft was folded into. */
    digest_post_id: number | null
  }
  /** Follow-up replies (post_parts, idx 2..3), in order. Empty for a single post. */
  parts: {
    idx: number
    text: string
    status: 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED'
    attempts: number
    last_error: string | null
    link_url: string | null
  }[]
  /** Character limits the editor checks before sending (the server checks again). */
  limits: {
    /** THREADS_TEXT_LIMIT (500): main post and every follow-up but the last. */
    text: number
    /** The last follow-up keeps room for the CTA (lastFollowupLimit). */
    lastFollowup: number
    cta: string | null
  }
}

/**
 * GET /api/revivable: EXPIRED news drafts of the last 30 days that were neither revived nor
 * digested (loadRevivable), newest first, with the stored verdict (null until judged).
 */
export type RevivableResponse = {
  rows: {
    id: number
    title: string
    text: string
    source_url: string | null
    created_at: string
    verdict: 'evergreen' | 'stale' | null
    reason: string | null
    checked_at: string | null
  }[]
}

/**
 * POST /api/posts/:id/<action>: Threads operations (docs/dashboard.md). Same session, same-origin
 * and `X-CSRF-Token` rules as the campaign actions. Draft actions carry the `revision` the page
 * displayed; schedule actions carry the `scheduled_at` it displayed (ISO string), like the
 * Telegram buttons bound to that slot. An outdated view changes nothing: 409 `PostActionConflict`.
 */
export type PostActionRequests = {
  /** ✅ 승인 (PENDING_REVIEW): takes the next free publish slot. */
  approve: { revision: number }
  /** 🗑 폐기 with a reason (PENDING_REVIEW). */
  reject: { revision: number; reason: PostRejectReason }
  /** 🔁 재생성, with optional feedback (PENDING_REVIEW). Queued; the page polls for the result. */
  regenerate: { revision: number; feedback?: string }
  /** Replaces part `idx` verbatim, like `수정<idx>:` (1 = main post). PENDING_REVIEW. */
  edit: { revision: number; idx: number; text: string }
  /** Deletes follow-up `idx` (2..3), like `삭제<idx>`; later parts are renumbered. PENDING_REVIEW. */
  deletePart: { revision: number; idx: number }
  /** ⏪ 예약 취소 (SCHEDULED at `scheduledAt`): back to review. */
  unschedule: { scheduledAt: string }
  /** 🚀 지금 발행 (SCHEDULED at `scheduledAt`): the slot moves to now; the 5-min sweep publishes. */
  publishNow: { scheduledAt: string }
  /** 🔁 답글 다시 시도 (PUBLISHED with FAILED parts). */
  retryParts: Record<string, never>
  /** ♻️ 살리기 (EXPIRED, not revived, not digested). Queued; the result goes to review. */
  revive: Record<string, never>
}
export type PostActionName = keyof PostActionRequests

/** 200: the action applied (or was queued); `detail` is the post as it is now. */
export type PostActionResponse = {
  ok: true
  /** False when Telegram could not be updated (logged; the action itself applied). */
  telegramSynced: boolean
  detail: PostDetailResponse | null
}

/** 409: the post changed since the page showed it, or was already handled. */
export type PostActionConflict = ApiError & { stale: true }

/**
 * POST /api/posts/add `{ url, note? }`: a manual topic and its draft, like Telegram `/add`.
 * 200 `{ topicId }` when queued; 409 `{ error, postId }` when the URL was already covered.
 */
export type AddTopicRequest = { url: string; note?: string }
export type AddTopicResponse = { ok: true; topicId: number }
export type AddTopicConflict = ApiError & { postId: number }

/**
 * Queued Threads jobs (body `{}`), answered 202 `{ ok: true }` once queued; their results go to
 * Telegram and appear in the lists on the next refetch:
 * - POST /api/revivable/check: judge the expired drafts (revive-check, like /revive)
 * - POST /api/digest: build the weekly digest now (weekly-digest, like /digest)
 */
export type QueuedResponse = { ok: true }
