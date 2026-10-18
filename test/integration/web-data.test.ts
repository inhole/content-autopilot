import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { loadCampaignCounts, loadStatus } from '../../src/pipeline/status.ts'
import {
  loadCampaignDetail,
  loadCampaignList,
  loadInsights,
  loadOverview,
  loadRecentPosts,
  parseCampaignFilter,
  parseCampaignSource,
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

describe('sources', () => {
  it('counts per source and filters the list by source', async () => {
    const gift = await seedCampaign({ status: 'APPLIED' })
    const m1 = await seedCampaign({ status: 'PENDING_REVIEW', source: 'musinsa' })
    await seedCampaign({ status: 'APPLIED', source: 'musinsa' })
    const o = await loadOverview()
    expect(o.campaigns.bySource).toEqual({
      'kakao-gift': { APPLIED: 1 },
      musinsa: { PENDING_REVIEW: 1, APPLIED: 1 },
    })
    const rows = await loadCampaignList('all', 'musinsa')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'musinsa')).toBe(true)
    expect((await loadCampaignList('PENDING_REVIEW', 'musinsa')).map((r) => r.id)).toEqual([m1])
    expect((await loadCampaignList('active', 'kakao-gift')).map((r) => r.id)).toEqual([gift])
    expect(await loadCampaignList('all')).toHaveLength(3)
    expect(parseCampaignSource('musinsa')).toBe('musinsa')
    expect(parseCampaignSource('nope')).toBeNull()

    const counts = await loadCampaignCounts()
    expect(counts.bySource.find((b) => b.source === 'musinsa')).toMatchObject({
      pendingReview: 1,
      applied: 1,
    })
    expect(counts.bySource.find((b) => b.source === 'kakao-gift')).toMatchObject({ applied: 1 })
  })
})

async function seedInsight(postId: number, collectedAt: Date, over: Record<string, number> = {}) {
  await query(
    `insert into post_insights (post_id, collected_at, views, likes, replies, reposts)
     values ($1, $2, $3, $4, $5, $6)`,
    [postId, collectedAt, over.views ?? 0, over.likes ?? 0, over.replies ?? 0, over.reposts ?? 0],
  )
}

describe('loadRecentPosts origin', () => {
  it('returns the origin of each post', async () => {
    await seedPost('PUBLISHED', { published_at: new Date(), origin: 'revived' })
    await seedPost('PENDING_REVIEW')
    const rows = await loadRecentPosts(10)
    expect(rows.map((r) => r.origin).sort()).toEqual(['news', 'revived'])
  })
})

describe('loadInsights', () => {
  const now = new Date('2026-10-18T03:00:00Z')

  it('uses the latest snapshot per post and sums by KST publish day', async () => {
    // 2026-10-17T15:30Z is already 10-18 in KST; 10-17T14:00Z is still 10-17.
    const a = await seedPost('PUBLISHED', { published_at: new Date('2026-10-17T15:30:00Z') })
    const b = await seedPost('PUBLISHED', { published_at: new Date('2026-10-17T14:00:00Z') })
    const c = await seedPost('PUBLISHED', { published_at: new Date('2026-10-17T01:00:00Z') })
    await seedInsight(a, new Date('2026-10-17T20:00:00Z'), { views: 5, likes: 1 })
    await seedInsight(a, new Date('2026-10-18T01:00:00Z'), { views: 50, likes: 4, replies: 2 })
    await seedInsight(b, new Date('2026-10-18T01:00:00Z'), { views: 30, likes: 3 })
    // c has no snapshot: counts as a post with zero metrics.
    const r = await loadInsights(30, now)
    expect(r.days).toBe(30)
    expect(r.daily).toEqual([
      { date: '2026-10-17', posts: 2, views: 30, likes: 3, replies: 0 },
      { date: '2026-10-18', posts: 1, views: 50, likes: 4, replies: 2 },
    ])
    expect(r.top.map((t) => t.id)).toEqual([a, b, c])
    expect(r.top[0]).toMatchObject({ views: 50, likes: 4, replies: 2, reposts: 0 })
    expect(r.top[2]).toMatchObject({ views: null, likes: null })
  })

  it('limits to the window, published posts and the top 10', async () => {
    await seedPost('PUBLISHED', { published_at: new Date('2026-08-01T00:00:00Z') })
    await seedPost('SCHEDULED', { scheduled_at: new Date('2026-10-19T00:00:00Z') })
    for (let i = 0; i < 12; i++) {
      const id = await seedPost('PUBLISHED', {
        published_at: new Date(Date.parse('2026-10-10T00:00:00Z') + i * 3_600_000),
      })
      await seedInsight(id, new Date('2026-10-11T00:00:00Z'), { views: i })
    }
    const r = await loadInsights(30, now)
    expect(r.daily.reduce((n, d) => n + d.posts, 0)).toBe(12)
    expect(r.top).toHaveLength(10)
    expect(r.top.map((t) => t.views)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
    expect((await loadInsights(7, now)).daily.length).toBe(0)
  })

  it('is empty without published posts', async () => {
    expect(await loadInsights(30, now)).toEqual({ days: 30, daily: [], top: [] })
  })
})
