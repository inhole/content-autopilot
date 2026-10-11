import { query } from '../db/pool.ts'
import { getThreadsApi } from '../threads/account.ts'
import type { ThreadsApi } from '../threads/client.ts'
import type { Insights } from '../threads/insights.ts'

/** Counts keep moving for a while after publishing; older posts are no longer worth polling. */
const COLLECT_WINDOW_DAYS = 14
const REPORT_WINDOW_DAYS = 7
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
}

/** Published posts of the last 7 days (non-dry) with their latest snapshot. */
export async function loadInsightRows(now = new Date()): Promise<InsightRow[]> {
  const since = new Date(now.getTime() - REPORT_WINDOW_DAYS * 86_400_000)
  const rows = await query<
    {
      id: number
      text: string
      published_at: Date
      has_snapshot: boolean
      has_parts: boolean
    } & Insights
  >(
    `select p.id, p.text, p.published_at, (i.id is not null) as has_snapshot,
            exists (select 1 from post_parts pp where pp.post_id = p.id) as has_parts,
            i.views, i.likes, i.replies, i.reposts, i.quotes, i.shares
     from posts p
     left join lateral (
       select * from post_insights where post_id = p.id order by collected_at desc, id desc limit 1
     ) i on true
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
    metrics: r.has_snapshot
      ? {
          views: r.views,
          likes: r.likes,
          replies: r.replies,
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
  `#${r.postId} "${preview(r.text)}" — 👁 ${show(r.metrics?.views ?? null)} · 💬 ${show(r.metrics?.replies ?? null)} · ❤️ ${show(r.metrics?.likes ?? null)}`

/** Average of a metric over the rows that report it; null when none does (unknown, not zero). */
function average(rows: InsightRow[], k: keyof Insights): number | null {
  const rs = rows.filter((r) => r.metrics?.[k] != null)
  if (rs.length === 0) return null
  return rs.reduce((a, r) => a + n(r.metrics?.[k]), 0) / rs.length
}

function chainLine(label: string, rows: InsightRow[]): string {
  const avg = (k: keyof Insights) => {
    const v = average(rows, k)
    return v === null ? '-' : String(Math.round(v))
  }
  return `${label} ${rows.length}개 — 평균 조회 ${avg('views')} · 평균 답글 ${avg('replies')}`
}

/** Chain vs single comparison over the main posts; empty when there is nothing to compare. */
export function chainComparison(rows: InsightRow[]): string[] {
  const chain = rows.filter((r) => r.hasParts)
  if (chain.length === 0) return []
  const single = rows.filter((r) => !r.hasParts)
  return [
    '',
    '🔗 연결 글 vs 단일 글 (본글 기준)',
    chainLine('연결 글', chain),
    single.length ? chainLine('단일 글', single) : '단일 글 없음',
    '표본이 작아 참고용이에요.',
  ]
}

/** Builds the Telegram text for the last 7 days from rows (latest snapshot per post). */
export function buildWeeklyReport(rows: InsightRow[]): string {
  const header = '📊 주간 Threads 리포트 (최근 7일)'
  if (rows.length === 0) return `${header}\n\n이번 주에 발행된 글이 없어요.`

  const measured = rows.filter((r) => r.metrics !== null)
  if (measured.length === 0) {
    return `${header}\n\n발행 ${rows.length}개, 아직 수집된 성과 숫자가 없어요. (npm run cli -- insights)`
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

  out.push(...chainComparison(rows))

  const byReplies = has('replies').sort(
    (a, b) =>
      n(b.metrics?.replies) - n(a.metrics?.replies) || n(b.metrics?.views) - n(a.metrics?.views),
  )
  if (byReplies.length) {
    out.push('', '💬 답글 많은 글', ...byReplies.slice(0, TOP_SHOWN).map(line))
  }

  const withViews = has('views')
  if (withViews.length > 1) {
    const worst = withViews.sort((a, b) => n(a.metrics?.views) - n(b.metrics?.views))[0]
    if (worst) out.push('', '📉 조회 가장 적은 글', line(worst))
  }
  return out.join('\n')
}

export const weeklyReport = async (now = new Date()) =>
  buildWeeklyReport(await loadInsightRows(now))
