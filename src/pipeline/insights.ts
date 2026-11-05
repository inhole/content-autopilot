import { query } from '../db/pool.ts'
import { getThreadsApi } from '../threads/account.ts'
import type { ThreadsApi } from '../threads/client.ts'
import type { Insights } from '../threads/insights.ts'
import { videoReport } from '../video/insights.ts'
import { PROMPT_VERSION } from './prompts.ts'

/** Counts keep moving for a while after publishing; older posts are no longer worth polling. */
const COLLECT_WINDOW_DAYS = 14
const REPORT_WINDOW_DAYS = 7
// The format comparison needs more posts than a week gives (decision 16).
const COMPARE_WINDOW_DAYS = 28
const TOP_SHOWN = 3
const PREVIEW_CHARS = 28

export type CollectResult = {
  collected: number
  /** Posts whose response had no known metric; nothing is stored for them. */
  empty: number
  failed: { postId: number; error: string }[]
}

/** Posts published in dry-run mode carry `dry-` ids and do not exist on Threads. */
export const isDryRunId = (platformPostId: string) => platformPostId.startsWith('dry-')

/** Stores one snapshot per recent published post. A failing post is logged and skipped. */
export async function collectInsights(now = new Date(), api?: ThreadsApi): Promise<CollectResult> {
  const since = new Date(now.getTime() - COLLECT_WINDOW_DAYS * 86_400_000)
  const posts = await query<{ id: number; platform_post_id: string }>(
    `select id, platform_post_id from posts
     where status = 'PUBLISHED' and platform_post_id is not null and published_at >= $1
     order by id`,
    [since],
  )
  const targets = posts.filter((p) => !isDryRunId(p.platform_post_id))
  const result: CollectResult = { collected: 0, empty: 0, failed: [] }
  if (targets.length === 0) return result

  const threads = api ?? (await getThreadsApi())
  for (const p of targets) {
    try {
      const m = await threads.getInsights(p.platform_post_id)
      // An all-unknown snapshot (dry-run client, empty response) carries no information and,
      // being the latest, would hide the last real numbers from the report.
      if (Object.values(m).every((v) => v === null)) {
        result.empty++
        continue
      }
      await query(
        `insert into post_insights (post_id, views, likes, replies, reposts, quotes, shares)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, m.views, m.likes, m.replies, m.reposts, m.quotes, m.shares],
      )
      result.collected++
    } catch (err) {
      const error = (err as Error).message
      console.error(`[insights] post ${p.id} failed: ${error}`)
      result.failed.push({ postId: p.id, error })
    }
  }
  return result
}

export type InsightRow = {
  postId: number
  text: string
  publishedAt: Date
  /** Null when no snapshot has been collected for the post yet. */
  metrics: Insights | null
  /** True when the post has follow-up parts (a thread chain); insights cover the main post only. */
  hasParts?: boolean
  origin?: string
  promptVersion?: number | null
  /** Views of the latest snapshot taken a day or more after publishing; null before that. */
  matureViews?: number | null
}

/**
 * Lateral join on `posts p` giving `mv.views`: the latest snapshot taken at least a day after
 * publishing. Views are nearly final by then, so posts of different ages compare fairly.
 */
export const MATURE_VIEWS_JOIN = `left join lateral (
  select views from post_insights
  where post_id = p.id and collected_at >= p.published_at + interval '1 day' and views is not null
  order by collected_at desc, id desc limit 1
) mv on true`

/**
 * Published posts of the last `days` days (non-dry) with their latest snapshot. Threads counts the
 * owner's own follow-up replies in `replies`, so the published parts are subtracted.
 */
export async function loadInsightRows(
  now = new Date(),
  days = REPORT_WINDOW_DAYS,
): Promise<InsightRow[]> {
  const since = new Date(now.getTime() - days * 86_400_000)
  const rows = await query<
    {
      id: number
      text: string
      published_at: Date
      has_snapshot: boolean
      has_parts: boolean
      own_replies: number
      origin: string
      prompt_version: number | null
      mature_views: number | null
    } & Insights
  >(
    `select p.id, p.text, p.published_at, (i.id is not null) as has_snapshot,
            -- A chain whose follow-ups all failed reached readers as a single post.
            exists (select 1 from post_parts pp
                    where pp.post_id = p.id and pp.status = 'PUBLISHED') as has_parts,
            (select count(*) from post_parts pp
             where pp.post_id = p.id and pp.status = 'PUBLISHED')::int as own_replies,
            p.origin,
            case when p.generation->>'prompt_version' ~ '^[0-9]+$'
                 then (p.generation->>'prompt_version')::int end as prompt_version,
            mv.views as mature_views,
            i.views, i.likes, i.replies, i.reposts, i.quotes, i.shares
     from posts p
     left join lateral (
       select * from post_insights where post_id = p.id order by collected_at desc, id desc limit 1
     ) i on true
     ${MATURE_VIEWS_JOIN}
     where p.status = 'PUBLISHED' and p.published_at >= $1
       and p.platform_post_id is not null and p.platform_post_id not like 'dry-%'
     order by p.published_at`,
    [since],
  )
  return rows.map((r) => ({
    postId: r.id,
    text: r.text,
    publishedAt: r.published_at,
    hasParts: r.has_parts,
    origin: r.origin,
    promptVersion: r.prompt_version,
    matureViews: r.mature_views,
    metrics: r.has_snapshot
      ? {
          views: r.views,
          likes: r.likes,
          replies: r.replies === null ? null : Math.max(r.replies - r.own_replies, 0),
          reposts: r.reposts,
          quotes: r.quotes,
          shares: r.shares,
        }
      : null,
  }))
}

const n = (v: number | null | undefined) => v ?? 0
const show = (v: number | null) => (v === null ? '-' : String(v))

function preview(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  return first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS)}…` : first
}

const line = (r: InsightRow) =>
  `#${r.postId} "${preview(r.text)}" · 조회 ${show(r.metrics?.views ?? null)} · 답글 ${show(r.metrics?.replies ?? null)} · 좋아요 ${show(r.metrics?.likes ?? null)}`

/** Median of a non-empty list (mean of the middle two for an even count). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

const groupLine = (label: string, views: number[]) =>
  views.length
    ? `${label} ${views.length}개 · 조회 중앙값 ${Math.round(median(views))}`
    : `${label} 없음 · 비교 불가`

/**
 * The format experiment (decision 16): chain vs single news posts in the current voice, by views a
 * day or more after publishing. Digests, revived drafts and older voices would blur the format
 * effect, so they are left out. Empty when no post qualifies.
 */
export function chainComparison(rows: InsightRow[]): string[] {
  const eligible = rows.filter(
    (r) => r.origin === 'news' && r.promptVersion === PROMPT_VERSION && r.matureViews != null,
  )
  if (eligible.length === 0) return []
  const views = (chain: boolean) =>
    eligible.filter((r) => Boolean(r.hasParts) === chain).map((r) => r.matureViews as number)
  return [
    '',
    `▸ 연결 글 vs 단독 글 (최근 ${COMPARE_WINDOW_DAYS}일 · 발행 1일 뒤 조회)`,
    groupLine('연결 글', views(true)),
    groupLine('단독 글', views(false)),
    '표본이 작아 참고용이에요.',
  ]
}

/**
 * Builds the Telegram text for the last 7 days from rows (latest snapshot per post). The format
 * comparison uses `compareRows`, a longer window (weeklyReport passes the last 28 days).
 */
export function buildWeeklyReport(rows: InsightRow[], compareRows: InsightRow[] = rows): string {
  const header = '■ 주간 Threads 리포트 (최근 7일)'
  // The comparison spans 28 days, so it still has something to say after a quiet week.
  const withComparison = (text: string) =>
    [`${header}\n\n${text}`, ...chainComparison(compareRows)].join('\n')
  if (rows.length === 0) return withComparison('이번 주에 발행된 글이 없어요.')

  const measured = rows.filter((r) => r.metrics !== null)
  if (measured.length === 0) {
    return withComparison(
      `발행 ${rows.length}개, 아직 수집된 성과 숫자가 없어요. (npm run cli -- insights)`,
    )
  }

  // A null metric is unknown, not zero: each total and average uses only the posts that report it.
  const has = (k: keyof Insights) => measured.filter((r) => r.metrics?.[k] != null)
  const total = (rs: InsightRow[], k: keyof Insights) =>
    rs.reduce((a, r) => a + n(r.metrics?.[k]), 0)
  const stat = (label: string, k: keyof Insights) => {
    const rs = has(k)
    if (rs.length === 0) return `${label} -`
    const t = total(rs, k)
    return `${label} ${t} (평균 ${Math.round(t / rs.length)})`
  }
  const rated = has('views').filter((r) => r.metrics?.replies != null)
  const ratedViews = total(rated, 'views')
  const out = [
    header,
    '',
    `발행 ${rows.length}개${measured.length < rows.length ? ` (집계 ${measured.length}개)` : ''}`,
    stat('조회', 'views'),
    stat('좋아요', 'likes'),
    stat('답글', 'replies'),
    stat('리포스트', 'reposts'),
    ratedViews > 0
      ? `답글률 ${((total(rated, 'replies') / ratedViews) * 1000).toFixed(1)} (조회 1000당 답글)`
      : '답글률 계산 불가 (조회 0 또는 미집계)',
  ]

  out.push(...chainComparison(compareRows))

  const byReplies = has('replies').sort(
    (a, b) =>
      n(b.metrics?.replies) - n(a.metrics?.replies) || n(b.metrics?.views) - n(a.metrics?.views),
  )
  if (byReplies.length) {
    out.push('', '▸ 답글 많은 글', ...byReplies.slice(0, TOP_SHOWN).map(line))
  }

  const withViews = has('views')
  if (withViews.length > 1) {
    const worst = withViews.sort((a, b) => n(a.metrics?.views) - n(b.metrics?.views))[0]
    if (worst) out.push('', '▸ 조회 가장 적은 글', line(worst))
  }
  return out.join('\n')
}

/** The Threads report plus the video section (docs/plans/video.md 3-12) when videos went out. */
export const weeklyReport = async (now = new Date()) =>
  [
    buildWeeklyReport(await loadInsightRows(now), await loadInsightRows(now, COMPARE_WINDOW_DAYS)),
    ...(await videoReport(now)),
  ].join('\n')
