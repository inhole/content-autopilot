import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

const { query } = await import('../../src/db/pool.ts')
const { rankCollected } = await import('../../src/pipeline/rank.ts')
const { seedPost, seedTopic } = await import('./helpers.ts')

describe('rankCollected recent topics', () => {
  beforeEach(() => chatJson.mockReset())

  it('shows mature views only for recent topics whose published post has them', async () => {
    const [source] = await query<{ id: number }>(
      `insert into sources (name, url) values ('feed', 'https://example.com/rank-views.xml')
       on conflict (url) do update set name = excluded.name returning id`,
    )
    const candidate = await seedTopic({ title: '후보 주제', status: 'COLLECTED' })
    await query('update topics set source_id = $2 where id = $1', [candidate, source?.id])

    const read = await seedTopic({ title: '읽힌 주제', status: 'USED' })
    const young = await seedTopic({ title: '어린 주제', status: 'USED' })
    for (const [topicId, hoursAfter] of [
      [read, 30],
      [young, 5],
    ]) {
      const postId = await seedPost(topicId as number, { status: 'PUBLISHED' })
      await query(`update posts set published_at = now() - interval '3 days' where id = $1`, [
        postId,
      ])
      await query(
        `insert into post_insights (post_id, collected_at, views)
         select id, published_at + make_interval(hours => $2), 77 from posts where id = $1`,
        [postId, hoursAfter],
      )
    }
    chatJson.mockResolvedValueOnce({
      scores: [{ id: candidate, score: 7, reason: 'r', duplicate_of: null }],
    })

    await rankCollected(1)

    const user = (chatJson.mock.calls[0] as [{ user: string }])[0].user
    expect(user).toContain(`[${read}] 읽힌 주제 · 조회 77`)
    expect(user).toContain(`[${young}] 어린 주제\n`)
    expect(user).not.toContain('어린 주제 · 조회')
  })
})
