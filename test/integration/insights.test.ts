import { describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { buildWeeklyReport, collectInsights, loadInsightRows } from '../../src/pipeline/insights.ts'
import { loadChainParts } from '../../src/pipeline/status.ts'
import { DryRunThreadsClient } from '../../src/threads/client.ts'
import { emptyInsights, type Insights } from '../../src/threads/insights.ts'
import { seedPost, seedTopic } from './helpers.ts'

async function publishedPost(platformPostId: string, daysAgo = 0) {
  const postId = await seedPost(await seedTopic(), { status: 'PUBLISHED' })
  await query(
    `update posts set platform_post_id = $2, published_at = now() - make_interval(days => $3)
     where id = $1`,
    [postId, platformPostId, daysAgo],
  )
  return postId
}

const metrics = (views: number, replies: number): Insights => ({
  ...emptyInsights(),
  views,
  replies,
})

function apiReturning(...results: (Insights | Error)[]) {
  const getInsights = vi.fn()
  for (const r of results) {
    if (r instanceof Error) getInsights.mockRejectedValueOnce(r)
    else getInsights.mockResolvedValueOnce(r)
  }
  return Object.assign(new DryRunThreadsClient(), { getInsights })
}

describe('collectInsights', () => {
  it('snapshots recent real posts, skips dry-run and old ones, isolates failures', async () => {
    const a = await publishedPost('media-a')
    const b = await publishedPost('media-b')
    await publishedPost('dry-post-1')
    await publishedPost('media-old', 20)
    const api = apiReturning(metrics(100, 3), new Error('boom'))

    const result = await collectInsights(new Date(), api)

    expect(api.getInsights).toHaveBeenCalledTimes(2)
    expect(result.collected).toBe(1)
    expect(result.failed).toEqual([{ postId: b, error: 'boom' }])
    const rows = await query<{ post_id: number; views: number }>(
      'select post_id, views from post_insights',
    )
    expect(rows).toEqual([{ post_id: a, views: 100 }])
  })

  it('stores nothing for an all-unknown response so the last real numbers stay latest', async () => {
    const a = await publishedPost('media-a')
    await query('insert into post_insights (post_id, views) values ($1, 70)', [a])

    const result = await collectInsights(new Date(), apiReturning(emptyInsights()))

    expect(result).toMatchObject({ collected: 0, empty: 1, failed: [] })
    const [latest] = await loadInsightRows()
    expect(latest?.metrics?.views).toBe(70)
  })
})

describe('loadInsightRows', () => {
  it('uses the latest snapshot per post and marks posts without one', async () => {
    const a = await publishedPost('media-a')
    const b = await publishedPost('media-b')
    await query(
      `insert into post_insights (post_id, collected_at, views, replies) values
       ($1, now() - interval '1 day', 10, 0), ($1, now(), 50, 4)`,
      [a],
    )

    const rows = await loadInsightRows()

    expect(rows.map((r) => r.postId)).toEqual([a, b])
    expect(rows[0]?.metrics).toMatchObject({ views: 50, replies: 4, likes: null })
    expect(rows[1]?.metrics).toBeNull()
  })
})

describe('chain data in reports and status', () => {
  const addPart = (postId: number, idx: number, status: string, minutesAgo = 0) =>
    query(
      `insert into post_parts (post_id, idx, text, status, updated_at)
       values ($1, $2, 'part', $3, now() - make_interval(mins => $4))`,
      [postId, idx, status, minutesAgo],
    )

  it('flags posts with parts and compares them with single posts', async () => {
    const chain = await publishedPost('media-chain')
    const single = await publishedPost('media-single')
    await addPart(chain, 2, 'PUBLISHED')
    await query(
      'insert into post_insights (post_id, views, replies) values ($1, 400, 6), ($2, 100, 0)',
      [chain, single],
    )

    const rows = await loadInsightRows()

    expect(rows.map((r) => [r.postId, r.hasParts])).toEqual([
      [chain, true],
      [single, false],
    ])
    // The owner's own published follow-up is not a reader reply.
    expect(rows[0]?.metrics?.replies).toBe(5)
    expect(rows[1]?.metrics?.replies).toBe(0)
  })

  it('counts failed parts and stale unfinished parts of published posts', async () => {
    const live = await publishedPost('media-live')
    await addPart(live, 2, 'FAILED')
    await addPart(live, 3, 'PENDING', 60)
    const fresh = await publishedPost('media-fresh')
    await addPart(fresh, 2, 'PUBLISHING', 2)

    expect(await loadChainParts()).toEqual({ failed: 1, stuck: 1 })
  })
})

describe('format experiment data', () => {
  async function experimentPost(opts: {
    views: { hoursAfter: number; views: number }[]
    parts?: string[]
    origin?: string
    promptVersion?: number
    hoursAgo?: number
  }) {
    const postId = await seedPost(await seedTopic(), { status: 'PUBLISHED' })
    await query(
      `update posts set platform_post_id = 'media-' || id, origin = $2,
         generation = jsonb_build_object('prompt_version', $3::int),
         published_at = now() - make_interval(hours => $4)
       where id = $1`,
      [postId, opts.origin ?? 'news', opts.promptVersion ?? 2, opts.hoursAgo ?? 72],
    )
    for (const [i, status] of (opts.parts ?? []).entries()) {
      await query(
        "insert into post_parts (post_id, idx, text, status) values ($1, $2, 'part', $3)",
        [postId, i + 2, status],
      )
    }
    for (const v of opts.views) {
      await query(
        `insert into post_insights (post_id, collected_at, views, replies)
         select id, published_at + make_interval(hours => $2), $3, 2 from posts where id = $1`,
        [postId, v.hoursAfter, v.views],
      )
    }
    return postId
  }

  it('reads mature views a day after publishing and subtracts only published own replies', async () => {
    const chain = await experimentPost({
      parts: ['PUBLISHED', 'FAILED'],
      views: [
        { hoursAfter: 8, views: 3 },
        { hoursAfter: 30, views: 9 },
      ],
    })
    const young = await experimentPost({ hoursAgo: 10, views: [{ hoursAfter: 8, views: 50 }] })

    const rows = await loadInsightRows(new Date(), 28)
    const byId = new Map(rows.map((r) => [r.postId, r]))

    expect(byId.get(chain)).toMatchObject({
      hasParts: true,
      origin: 'news',
      promptVersion: 2,
      matureViews: 9,
    })
    // Threads says 2 replies; one is the owner's published follow-up, the failed one never went out.
    expect(byId.get(chain)?.metrics?.replies).toBe(1)
    expect(byId.get(young)?.matureViews).toBeNull()
  })

  it('counts a chain whose follow-ups all failed as a single post', async () => {
    const postId = await experimentPost({
      parts: ['FAILED'],
      views: [{ hoursAfter: 30, views: 5 }],
    })
    const [row] = await loadInsightRows(new Date(), 28)
    expect(row).toMatchObject({ postId, hasParts: false, matureViews: 5 })
  })

  it('compares formats over the 28-day window in the weekly report', async () => {
    await experimentPost({
      parts: ['PUBLISHED'],
      hoursAgo: 24 * 20,
      views: [{ hoursAfter: 30, views: 4 }],
    })
    await experimentPost({ hoursAgo: 24 * 20, views: [{ hoursAfter: 30, views: 80 }] })
    await experimentPost({
      origin: 'digest',
      parts: ['PUBLISHED'],
      views: [{ hoursAfter: 30, views: 999 }],
    })

    const now = new Date()
    const report = buildWeeklyReport(await loadInsightRows(now), await loadInsightRows(now, 28))

    expect(report).toContain('연결 글 1개 · 조회 중앙값 4')
    expect(report).toContain('단독 글 1개 · 조회 중앙값 80')
  })
})
