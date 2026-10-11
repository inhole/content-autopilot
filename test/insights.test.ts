import { describe, expect, it, vi } from 'vitest'
import { buildWeeklyReport, type InsightRow, isDryRunId } from '../src/pipeline/insights.ts'
import { ThreadsClient } from '../src/threads/client.ts'
import { parseInsights } from '../src/threads/insights.ts'

describe('parseInsights', () => {
  it('reads the values shape', () => {
    const out = parseInsights({
      data: [
        { name: 'views', period: 'lifetime', values: [{ value: 120 }] },
        { name: 'likes', values: [{ value: 7 }] },
      ],
    })
    expect(out).toMatchObject({ views: 120, likes: 7 })
  })

  it('reads the total_value shape and ignores unknown metrics', () => {
    const out = parseInsights({
      data: [
        { name: 'replies', total_value: { value: 3 } },
        { name: 'clicks', total_value: { value: 9 } },
      ],
    })
    expect(out.replies).toBe(3)
    expect(out).not.toHaveProperty('clicks')
  })

  it('leaves missing metrics null', () => {
    const out = parseInsights({ data: [{ name: 'views', values: [{ value: 1 }] }] })
    expect(out).toEqual({
      views: 1,
      likes: null,
      replies: null,
      reposts: null,
      quotes: null,
      shares: null,
    })
  })

  it('rejects a malformed response', () => {
    expect(() => parseInsights({ error: 'x' })).toThrow(/unexpected insights response/)
  })
})

describe('ThreadsClient.getInsights', () => {
  it('requests the media insights endpoint with all metrics', async () => {
    const fetchMock = vi.fn(
      async (_url: URL | string | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ name: 'views', values: [{ value: 5 }] }] })),
    )
    const client = new ThreadsClient({
      baseUrl: 'https://graph.example',
      userId: 'u',
      accessToken: 't',
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect((await client.getInsights('m1')).views).toBe(5)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/v1.0/m1/insights')
    expect(url).toContain('metric=views%2Clikes%2Creplies%2Creposts%2Cquotes%2Cshares')
  })
})

describe('isDryRunId', () => {
  it('flags dry-run ids only', () => {
    expect(isDryRunId('dry-post-dry-container-1')).toBe(true)
    expect(isDryRunId('1789012345')).toBe(false)
  })
})

const m = (views: number | null, replies: number | null, likes: number | null = 0) => ({
  views,
  likes,
  replies,
  reposts: 0,
  quotes: 0,
  shares: 0,
})
const row = (postId: number, text: string, metrics: InsightRow['metrics']): InsightRow => ({
  postId,
  text,
  publishedAt: new Date('2026-10-10T00:00:00Z'),
  metrics,
})

describe('buildWeeklyReport', () => {
  it('handles a week without posts', () => {
    expect(buildWeeklyReport([])).toContain('발행된 글이 없어요')
  })

  it('handles posts without any snapshot', () => {
    expect(buildWeeklyReport([row(1, 'a', null)])).toContain('수집된 성과 숫자가 없어요')
  })

  it('summarizes totals, reply rate, top and bottom posts', () => {
    const out = buildWeeklyReport([
      row(1, '첫 글입니다\n둘째 줄', m(1000, 5)),
      row(2, 'B'.repeat(60), m(3000, 20, 40)),
      row(3, '세번째', m(200, 0)),
      row(4, '네번째', m(500, 1)),
    ])
    expect(out).toContain('발행 4개')
    expect(out).toContain('조회 4700 (평균 1175)')
    expect(out).toContain('답글 26 (평균 7)')
    expect(out).toContain('답글률 5.5')
    expect(out).toContain('"첫 글입니다"')
    expect(out).not.toContain('둘째 줄')
    expect(out).toContain(`"${'B'.repeat(28)}…"`)
    const top = out.split('📉')[0] ?? ''
    expect(top.indexOf('#2')).toBeLessThan(top.indexOf('#1'))
    expect(top).not.toContain('#3')
    expect(out.split('📉')[1]).toContain('#3')
  })

  it('treats null metrics as unknown and notes unmeasured posts', () => {
    const out = buildWeeklyReport([row(1, 'a', m(null, null, null)), row(2, 'b', null)])
    expect(out).toContain('발행 2개 (집계 1개)')
    expect(out).toContain('답글률 계산 불가')
    expect(out).toContain('조회 -')
  })

  it('averages and ranks each metric over the posts that report it', () => {
    const out = buildWeeklyReport([
      row(1, 'known', m(100, 2)),
      row(2, 'unknown views', m(null, 1)),
      row(3, 'low', m(40, null)),
    ])
    expect(out).toContain('조회 140 (평균 70)')
    expect(out).toContain('답글 3 (평균 2)')
    // Only post 1 has both views and replies: 2 / 100 * 1000.
    expect(out).toContain('답글률 20.0')
    expect(out.split('📉')[1]).toContain('#3')
    expect(out.split('📉')[1]).not.toContain('#2')
  })
})
