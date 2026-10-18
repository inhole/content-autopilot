import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import {
  loadCampaignDetail,
  loadCampaignList,
  loadOverview,
  loadRecentPosts,
  parseCampaignFilter,
} from '../../src/web/data.ts'
import { seedCampaign } from './campaign-helpers-review.ts'

async function seedPost(status: string, over: Record<string, unknown> = {}): Promise<number> {
  const [t] = await query<{ id: number }>(
    `insert into topics (title, url_hash) values ('t', $1) returning id`,
    [`h-${Math.random()}`],
  )
  const row: Record<string, unknown> = { topic_id: t?.id, text: 'hello world', status, ...over }
  const cols = Object.keys(row)
  const [p] = await query<{ id: number }>(
    `insert into posts (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    cols.map((c) => row[c]),
  )
  return p?.id as number
}

describe('parseCampaignFilter', () => {
  it('accepts statuses, all, and falls back to active', () => {
    expect(parseCampaignFilter('APPLIED')).toBe('APPLIED')
    expect(parseCampaignFilter('all')).toBe('all')
    expect(parseCampaignFilter('bogus')).toBe('active')
    expect(parseCampaignFilter(null)).toBe('active')
  })
})

describe('loadOverview', () => {
  it('counts posts, campaigns and heartbeats', async () => {
    await seedPost('PENDING_REVIEW')
    await seedPost('FAILED')
    await seedPost('PUBLISHED', { published_at: new Date() })
    await seedPost('PUBLISHED', { published_at: new Date(Date.now() - 3 * 86_400_000) })
    await seedPost('SCHEDULED', { scheduled_at: new Date(Date.now() + 3_600_000) })
    await seedCampaign({ status: 'PENDING_REVIEW' })
    await seedCampaign({ status: 'PENDING_REVIEW' })
    await seedCampaign({ status: 'POSTED' })
    await query(`insert into worker_heartbeats (role) values ('local')`)
    const o = await loadOverview()
    expect(o.posts.pendingReview).toBe(1)
    expect(o.posts.failed).toBe(1)
    expect(o.posts.published24h).toBe(1)
    expect(o.posts.scheduled).toHaveLength(1)
    expect(o.campaignCounts.PENDING_REVIEW).toBe(2)
    expect(o.campaignCounts.POSTED).toBe(1)
    expect(o.heartbeats.map((h) => h.role)).toEqual(['local'])
  })
})

describe('loadCampaignList', () => {
  it('filters by active/status/all and sorts by next deadline', async () => {
    const later = await seedCampaign({
      status: 'PENDING_REVIEW',
      apply_deadline: new Date(Date.now() + 5 * 86_400_000),
    })
    const sooner = await seedCampaign({
      status: 'APPROVED',
      apply_deadline: new Date(Date.now() + 1 * 86_400_000),
    })
    const none = await seedCampaign({ status: 'SELECTED' })
    await seedCampaign({ status: 'POSTED' })
    const active = await loadCampaignList('active')
    expect(active.map((c) => c.id)).toEqual([sooner, later, none])
    expect((await loadCampaignList('POSTED')).length).toBe(1)
    expect((await loadCampaignList('all')).length).toBe(4)
  })
})

describe('loadCampaignDetail', () => {
  it('returns the row with reminders and photo count, or null', async () => {
    const id = await seedCampaign({ status: 'SELECTED' })
    await query(`insert into campaign_reminders (campaign_id, kind) values ($1, 'review-d3')`, [id])
    await query(
      `insert into campaign_photos (campaign_id, idx, file_id, file_unique_id) values ($1, 0, 'f', 'u')`,
      [id],
    )
    const d = await loadCampaignDetail(id)
    expect(d?.campaign.id).toBe(id)
    expect(d?.reminders.map((r) => r.kind)).toEqual(['review-d3'])
    expect(d?.photoCount).toBe(1)
    expect(await loadCampaignDetail(999_999)).toBeNull()
  })
})

describe('loadRecentPosts', () => {
  it('joins the latest insights snapshot', async () => {
    const id = await seedPost('PUBLISHED', { published_at: new Date() })
    await query(
      `insert into post_insights (post_id, collected_at, views, likes, replies) values
       ($1, now() - interval '2 days', 5, 1, 0), ($1, now(), 50, 4, 2)`,
      [id],
    )
    const [row] = await loadRecentPosts()
    expect([row?.views, row?.likes, row?.replies]).toEqual([50, 4, 2])
  })
})
