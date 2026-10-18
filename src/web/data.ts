import { CAMPAIGN_STATUSES, type Campaign, type CampaignStatus } from '../campaigns/types.ts'
import { query } from '../db/pool.ts'

/** Read-only queries for the dashboard. Nothing here writes to the database. */

/** Statuses a campaign passes through while the owner still has something to do or wait for. */
export const ACTIVE_STATUSES: CampaignStatus[] = [
  'PENDING_REVIEW',
  'APPROVED',
  'APPLYING',
  'APPLY_FAILED',
  'APPLIED',
  'SELECTED',
  'RECEIVED',
  'DRAFT_REVIEW',
  'DRAFT_APPROVED',
  'DRAFT_SAVING',
  'DRAFT_SAVED',
  'DRAFT_FAILED',
]

export type CampaignFilter = CampaignStatus | 'active' | 'all'

export function parseCampaignFilter(value: string | null | undefined): CampaignFilter {
  if (value === 'all') return 'all'
  if ((CAMPAIGN_STATUSES as readonly string[]).includes(value ?? '')) return value as CampaignStatus
  return 'active'
}

export type OverviewData = {
  posts: {
    pendingReview: number
    scheduled: { id: number; text: string; scheduled_at: Date }[]
    published24h: number
    failed: number
  }
  /** Row count per campaign status; missing statuses count as zero. */
  campaignCounts: Partial<Record<CampaignStatus, number>>
  heartbeats: { role: string; seen_at: Date }[]
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
  const heartbeats = await query<{ role: string; seen_at: Date }>(
    'select role, seen_at from worker_heartbeats order by role',
  )
  const campaignCounts: Partial<Record<CampaignStatus, number>> = {}
  for (const r of campaignRows) campaignCounts[r.status] = Number(r.n)
  return {
    posts: {
      pendingReview: Number(counts?.pending_review ?? 0),
      scheduled,
      published24h: Number(counts?.published_24h ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    campaignCounts,
    heartbeats,
  }
}

export type CampaignListRow = Pick<
  Campaign,
  | 'id'
  | 'title'
  | 'status'
  | 'reward_won'
  | 'apply_deadline'
  | 'announce_at'
  | 'review_deadline'
  | 'score'
  | 'found_in'
  | 'updated_at'
> & { offer: string | null }

/** Deadline that matters for the stage the campaign is in; null when the stage has none. */
export function nextDeadline(
  c: Pick<Campaign, 'status' | 'apply_deadline' | 'announce_at' | 'review_deadline'>,
): Date | null {
  switch (c.status) {
    case 'PENDING_REVIEW':
    case 'APPROVED':
    case 'APPLYING':
    case 'APPLY_FAILED':
      return c.apply_deadline
    case 'APPLIED':
      return c.announce_at ?? c.apply_deadline
    default:
      return c.review_deadline
  }
}

export async function loadCampaignList(filter: CampaignFilter): Promise<CampaignListRow[]> {
  const where =
    filter === 'all' ? '' : filter === 'active' ? 'where status = any($1)' : 'where status = $1'
  const values = filter === 'all' ? [] : [filter === 'active' ? ACTIVE_STATUSES : filter]
  const rows = await query<CampaignListRow>(
    `select id, title, status, reward_won, apply_deadline, announce_at, review_deadline, score,
            found_in, updated_at, detail->>'offer' as offer
       from campaigns ${where}
      order by updated_at desc limit 300`,
    values,
  )
  // Soonest deadline first; rows without one go last, newest update first among them.
  return rows.sort((a, b) => {
    const da = nextDeadline(a)?.getTime() ?? Number.POSITIVE_INFINITY
    const db = nextDeadline(b)?.getTime() ?? Number.POSITIVE_INFINITY
    return da - db
  })
}

export type CampaignDetailData = {
  campaign: Campaign
  reminders: { kind: string; sent_at: Date }[]
  photoCount: number
}

export async function loadCampaignDetail(id: number): Promise<CampaignDetailData | null> {
  const [campaign] = await query<Campaign>('select * from campaigns where id = $1', [id])
  if (!campaign) return null
  const reminders = await query<{ kind: string; sent_at: Date }>(
    'select kind, sent_at from campaign_reminders where campaign_id = $1 order by sent_at',
    [id],
  )
  const [photos] = await query<{ n: number }>(
    'select count(*) as n from campaign_photos where campaign_id = $1',
    [id],
  )
  return { campaign, reminders, photoCount: Number(photos?.n ?? 0) }
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

export async function loadRecentPosts(limit = 50): Promise<PostRow[]> {
  return query<PostRow>(
    `select p.id, p.status, p.text, p.scheduled_at, p.published_at,
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
