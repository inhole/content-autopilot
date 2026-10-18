import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { loadCampaignCounts, loadStatus } from '../../src/pipeline/status.ts'
import {
  loadCampaignDetail,
  loadCampaignList,
  loadOverview,
  loadRecentPosts,
  parseCampaignFilter,
} from '../../src/web/data.ts'

let seq = 0

/** Inserts a campaign row; `over` maps column names to values. */
async function seedCampaign(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1
  const row: Record<string, unknown> = {
    external_id: `kg-${seq}`,
    url: `https://gift.kakao.com/product/${seq}`,
    url_hash: `hash-${seq}`,
    status: 'PENDING_REVIEW',
    title: `campaign ${seq}`,
    ...over,
  }
  const cols = Object.keys(row)
  const [res] = await query<{ id: number }>(
    `insert into campaigns (${cols.join(', ')})
     values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    cols.map((c) => row[c]),
  )
  if (!res) throw new Error('seedCampaign failed')
  return res.id
}

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000)

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
    expect(parseCampaignFilter('NOT_SELECTED')).toBe('NOT_SELECTED')
    expect(parseCampaignFilter('all')).toBe('all')
    expect(parseCampaignFilter('APPLYING')).toBe('active')
    expect(parseCampaignFilter(null)).toBe('active')
  })
})

describe('loadOverview', () => {
  it('counts posts and campaigns, the last collection and recent reviews', async () => {
    await seedPost('PENDING_REVIEW')
    await seedPost('FAILED')
    await seedPost('PUBLISHED', { published_at: new Date() })
    await seedPost('PUBLISHED', { published_at: new Date(Date.now() - 3 * 86_400_000) })
    await seedPost('SCHEDULED', { scheduled_at: new Date(Date.now() + 3_600_000) })
    const recent = daysFromNow(-1)
    await seedCampaign({ status: 'PENDING_REVIEW', last_seen_at: recent })
    await seedCampaign({
      status: 'PENDING_REVIEW',
      last_seen_at: new Date(recent.getTime() - 5 * 60_000),
    })
    // Older than the 10 minute window: not part of the last collection.
    await seedCampaign({ status: 'EXPIRED', last_seen_at: daysFromNow(-5) })
    await seedCampaign({ status: 'POSTED', posted_at: daysFromNow(-3) })
    await seedCampaign({ status: 'POSTED', posted_at: daysFromNow(-40) })
    const o = await loadOverview()
    expect(o.posts.pendingReview).toBe(1)
    expect(o.posts.failed).toBe(1)
    expect(o.posts.published24h).toBe(1)
    expect(o.posts.scheduled).toHaveLength(1)
    expect(o.campaigns.counts.PENDING_REVIEW).toBe(2)
    expect(o.campaigns.counts.POSTED).toBe(2)
    expect(o.campaigns.postedLast30d).toBe(1)
    expect(o.campaigns.lastCollectedAt?.getTime()).toBeGreaterThan(daysFromNow(-1.1).getTime())
    expect(o.campaigns.lastSeenCount).toBe(2)
  })
  it('has no last collection without campaigns', async () => {
    const o = await loadOverview()
    expect(o.campaigns.lastCollectedAt).toBeNull()
    expect(o.campaigns.lastSeenCount).toBe(0)
  })
})

describe('loadStatus campaign counts', () => {
  it('counts per status and the 30 day window', async () => {
    await seedCampaign({ status: 'PENDING_REVIEW' })
    await seedCampaign({ status: 'APPLIED' })
    await seedCampaign({ status: 'APPLIED' })
    await seedCampaign({ status: 'SELECTED' })
    await seedCampaign({ status: 'DRAFT_REVIEW' })
    await seedCampaign({ status: 'POSTED', posted_at: daysFromNow(-2) })
    await seedCampaign({ status: 'POSTED', posted_at: daysFromNow(-45) })
    const c = await loadCampaignCounts()
    expect(c).toMatchObject({
      pendingReview: 1,
      applied: 2,
      selected: 1,
      draftReview: 1,
      postedLast30d: 1,
    })
    expect(c.lastCollectedAt).toBeInstanceOf(Date)
    expect((await loadStatus()).campaigns.applied).toBe(2)
  })
  it('reports no collection when empty', async () => {
    expect((await loadCampaignCounts()).lastCollectedAt).toBeNull()
  })
})

describe('loadCampaignList', () => {
  it('filters by active/status/all and sorts by the stage deadline', async () => {
    const later = await seedCampaign({ status: 'PENDING_REVIEW', apply_deadline: daysFromNow(5) })
    const sooner = await seedCampaign({ status: 'APPLIED', apply_deadline: daysFromNow(1) })
    // SELECTED sorts by the review deadline, not by the (past) apply deadline.
    const review = await seedCampaign({
      status: 'SELECTED',
      apply_deadline: daysFromNow(-9),
      review_deadline: daysFromNow(3),
    })
    const none = await seedCampaign({ status: 'DRAFT_REVIEW' })
    await seedCampaign({ status: 'POSTED' })
    await seedCampaign({ status: 'SHORTLISTED' })
    const active = await loadCampaignList('active')
    expect(active.map((c) => c.id)).toEqual([sooner, review, later, none])
    expect((await loadCampaignList('POSTED')).length).toBe(1)
    expect((await loadCampaignList('all')).length).toBe(6)
  })
  it('returns the list columns', async () => {
    await seedCampaign({ brand: 'B', recruit_count: 10, application_count: 250, score: 77 })
    const [row] = await loadCampaignList('all')
    expect(row).toMatchObject({ brand: 'B', recruit_count: 10, application_count: 250 })
    expect(Number(row?.score)).toBe(77)
  })
})

describe('loadCampaignDetail', () => {
  it('returns the row with reminders, or null', async () => {
    const id = await seedCampaign({
      status: 'DRAFT_REVIEW',
      brand: 'B',
      image_url: 'https://st.kakaocdn.net/a.png',
      memo: 'memo',
      draft_text: 'draft',
    })
    await query(`insert into campaign_reminders (campaign_id, kind) values ($1, 'review-d3')`, [id])
    const d = await loadCampaignDetail(id)
    expect(d?.campaign.id).toBe(id)
    expect(d?.campaign).toMatchObject({ brand: 'B', memo: 'memo', draft_text: 'draft' })
    expect(d?.reminders.map((r) => r.kind)).toEqual(['review-d3'])
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
