import { describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { collectInsights, loadInsightRows } from '../../src/pipeline/insights.ts'
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
