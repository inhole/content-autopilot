import {
  ACTIVE_CAMPAIGN_STATUSES,
  CAMPAIGN_SOURCE_KEYS,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignSource,
  type CampaignStatus,
  isCampaignSource,
} from '../campaigns/types.ts'
import { query } from '../db/pool.ts'

/** Read-only queries for the dashboard. Nothing here writes to the database. */

export { CAMPAIGN_SOURCE_KEYS }

export type CampaignFilter = CampaignStatus | 'active' | 'all'

export function parseCampaignFilter(value: string | null | undefined): CampaignFilter {
  if (value === 'all') return 'all'
  if ((CAMPAIGN_STATUSES as readonly string[]).includes(value ?? '')) return value as CampaignStatus
  return 'active'
}

/** The `?source=` filter; anything but a known source means all sources. */
export function parseCampaignSource(value: string | null | undefined): CampaignSource | null {
  return isCampaignSource(value) ? value : null
}

/** Campaigns whose `last_seen_at` is within this window of the newest one count as the last collection. */
export const LAST_COLLECTION_WINDOW_MINUTES = 10

export type OverviewData = {
  posts: {
    pendingReview: number
    scheduled: { id: number; text: string; scheduled_at: Date }[]
    published24h: number
    failed: number
  }
  campaigns: {
    /** Row count per campaign status; missing statuses count as zero. */
    counts: Partial<Record<CampaignStatus, number>>
    /** Newest `last_seen_at`; null when nothing was ever collected. */
    lastCollectedAt: Date | null
    /** Campaigns seen in that last collection. */
    lastSeenCount: number
    postedLast30d: number
    /** Row count per source and status; a source without rows is missing. */
    bySource: Partial<Record<CampaignSource, Partial<Record<CampaignStatus, number>>>>
  }
}

export async function loadOverview(): Promise<OverviewData> {
  const [counts] = await query<{
    pending_review: number
    published_24h: number
    failed: number
  }>(
    `select count(*) filter (where status = 'PENDING_REVIEW') as pending_review,
            count(*) filter (where status = 'PUBLISHED' and published_at > now() - interval '24 hours') as published_24h,
            count(*) filter (where status = 'FAILED') as failed
       from posts`,
  )
  const scheduled = await query<{ id: number; text: string; scheduled_at: Date }>(
    `select id, text, scheduled_at from posts
      where status in ('SCHEDULED', 'PUBLISHING') and scheduled_at is not null
      order by scheduled_at limit 20`,
  )
  const campaignRows = await query<{ status: CampaignStatus; n: number }>(
    'select status, count(*) as n from campaigns group by status',
  )
  const sourceRows = await query<{ source: string; status: CampaignStatus; n: number }>(
    'select source, status, count(*) as n from campaigns group by source, status',
  )
  const [seen] = await query<{ last_collected_at: Date | null; last_seen_count: number }>(
    `select max(last_seen_at) as last_collected_at,
            count(*) filter (where last_seen_at >= (select max(last_seen_at) from campaigns)
                                   - make_interval(mins => $1::int)) as last_seen_count
       from campaigns`,
    [LAST_COLLECTION_WINDOW_MINUTES],
  )
  const [posted] = await query<{ n: number }>(
    `select count(*) as n from campaigns
      where status = 'POSTED' and coalesce(posted_at, updated_at) > now() - interval '30 days'`,
  )
  const campaignCounts: Partial<Record<CampaignStatus, number>> = {}
  for (const r of campaignRows) campaignCounts[r.status] = Number(r.n)
  const bySource: OverviewData['campaigns']['bySource'] = {}
  for (const r of sourceRows) {
    if (!isCampaignSource(r.source)) continue
    const m = bySource[r.source] ?? {}
    m[r.status] = Number(r.n)
    bySource[r.source] = m
  }
  return {
    posts: {
      pendingReview: Number(counts?.pending_review ?? 0),
      scheduled,
      published24h: Number(counts?.published_24h ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    campaigns: {
      counts: campaignCounts,
      lastCollectedAt: seen?.last_collected_at ?? null,
      lastSeenCount: Number(seen?.last_seen_count ?? 0),
      postedLast30d: Number(posted?.n ?? 0),
      bySource,
    },
  }
}

export type CampaignListRow = Pick<
  Campaign,
  | 'id'
  | 'source'
  | 'title'
  | 'brand'
  | 'status'
  | 'recruit_count'
  | 'application_count'
  | 'apply_deadline'
  | 'review_deadline'
  | 'score'
  | 'updated_at'
>

/** The deadline of the current stage; an apply deadline is only an estimate. */
export type NextDeadline = { at: Date; kind: 'apply' | 'review' }

/** Deadline that matters for the stage the campaign is in; null when the stage has none. */
export function nextDeadline(
  c: Pick<Campaign, 'status' | 'apply_deadline' | 'review_deadline'>,
): NextDeadline | null {
  switch (c.status) {
    case 'COLLECTED':
    case 'SKIPPED':
    case 'SHORTLISTED':
    case 'PENDING_REVIEW':
    case 'APPLIED':
      return c.apply_deadline ? { at: c.apply_deadline, kind: 'apply' } : null
    case 'SELECTED':
    case 'DRAFT_REVIEW':
      return c.review_deadline ? { at: c.review_deadline, kind: 'review' } : null
    default:
      return null
  }
}

export async function loadCampaignList(
  filter: CampaignFilter,
  source: CampaignSource | null = null,
): Promise<CampaignListRow[]> {
  const conds: string[] = []
  const values: unknown[] = []
  if (filter !== 'all') {
    values.push(filter === 'active' ? ACTIVE_CAMPAIGN_STATUSES : filter)
    conds.push(
      filter === 'active' ? `status = any($${values.length})` : `status = $${values.length}`,
    )
  }
  if (source) {
    values.push(source)
    conds.push(`source = $${values.length}`)
  }
  const where = conds.length ? `where ${conds.join(' and ')}` : ''
  const rows = await query<CampaignListRow>(
    `select id, source, title, brand, status, recruit_count, application_count, apply_deadline,
            review_deadline, score, updated_at
       from campaigns ${where}
      order by updated_at desc limit 300`,
    values,
  )
  // Soonest deadline first; rows without one go last, newest update first among them (stable sort).
  return rows.sort((a, b) => {
    const da = nextDeadline(a)?.at.getTime() ?? Number.POSITIVE_INFINITY
    const db = nextDeadline(b)?.at.getTime() ?? Number.POSITIVE_INFINITY
    return da === db ? 0 : da < db ? -1 : 1
  })
}

export type CampaignDetailData = {
  campaign: Campaign
  reminders: { kind: string; sent_at: Date }[]
}

export async function loadCampaignDetail(id: number): Promise<CampaignDetailData | null> {
  const [campaign] = await query<Campaign>('select * from campaigns where id = $1', [id])
  if (!campaign) return null
  const reminders = await query<{ kind: string; sent_at: Date }>(
    'select kind, sent_at from campaign_reminders where campaign_id = $1 order by sent_at',
    [id],
  )
  return { campaign, reminders }
}

export type PostRow = {
  id: number
  status: string
  text: string
  scheduled_at: Date | null
  published_at: Date | null
  views: number | null
  likes: number | null
  replies: number | null
}

export type PostOrigin = 'news' | 'revived' | 'digest'

export type InsightsData = {
  days: number
  daily: { date: string; posts: number; views: number; likes: number; replies: number }[]
  top: {
    id: number
    text: string
    published_at: Date
    views: number | null
    likes: number | null
    replies: number | null
    reposts: number | null
  }[]
}

/** `?days=` of /api/insights: an integer clamped to 7..90, default 30. */
export function parseInsightsDays(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(n)) return 30
  return Math.min(90, Math.max(7, n))
}

/** `?limit=` of /api/posts: an integer clamped to 1..200, default 50. */
export function parsePostLimit(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(n)) return 50
  return Math.min(200, Math.max(1, n))
}

/**
 * Engagement of posts published within the last `days` days, from each post's latest insights
 * snapshot. `daily` sums by KST publish date (oldest first, only days with posts); `top` is the
 * 10 posts with the most views. Posts without any snapshot count as zero in `daily`.
 */
export async function loadInsights(days: number, now: Date = new Date()): Promise<InsightsData> {
  const rows = await query<{
    id: number
    text: string
    published_at: Date
    day: string
    views: number | null
    likes: number | null
    replies: number | null
    reposts: number | null
  }>(
    `select p.id, p.text, p.published_at,
            to_char(p.published_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as day,
            i.views, i.likes, i.replies, i.reposts
       from posts p
       left join lateral (
         select views, likes, replies, reposts from post_insights
          where post_id = p.id order by collected_at desc limit 1
       ) i on true
      where p.status = 'PUBLISHED' and p.published_at is not null
        and p.published_at > $1::timestamptz - make_interval(days => $2::int)
        and p.published_at <= $1::timestamptz
      order by p.published_at`,
    [now, days],
  )
  const byDay = new Map<string, InsightsData['daily'][number]>()
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { date: r.day, posts: 0, views: 0, likes: 0, replies: 0 }
    d.posts += 1
    d.views += Number(r.views ?? 0)
    d.likes += Number(r.likes ?? 0)
    d.replies += Number(r.replies ?? 0)
    byDay.set(r.day, d)
  }
  const top = [...rows]
    .sort((a, b) => Number(b.views ?? -1) - Number(a.views ?? -1) || b.id - a.id)
    .slice(0, 10)
    .map(({ day: _day, ...rest }) => rest)
  return { days, daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)), top }
}

export async function loadRecentPosts(limit = 50): Promise<(PostRow & { origin: PostOrigin })[]> {
  return query<PostRow & { origin: PostOrigin }>(
    `select p.id, p.status, p.text, p.scheduled_at, p.published_at, p.origin,
            i.views, i.likes, i.replies
       from posts p
       left join lateral (
         select views, likes, replies from post_insights
          where post_id = p.id order by collected_at desc limit 1
       ) i on true
      order by coalesce(p.published_at, p.scheduled_at, p.created_at) desc
      limit $1`,
    [limit],
  )
}
