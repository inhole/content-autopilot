import { describe, expect, it, vi } from 'vitest'
import { buildWeeklyReport, type InsightRow, isDryRunId, median } from '../src/pipeline/insights.ts'
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

  it('puts the start of the error body in the message', async () => {
    const body = JSON.stringify({
      error: { message: 'Invalid OAuth access token', pad: 'x'.repeat(400) },
    })
    const client = new ThreadsClient({
      baseUrl: 'https://graph.example',
      userId: 'u',
      accessToken: 't',
      fetch: (async () => new Response(body, { status: 400 })) as unknown as typeof fetch,
    })
    const err = (await client.getInsights('m1').catch((e: Error) => e)) as Error
    expect(err.message).toBe(`Threads GET /m1/insights 400: ${body.slice(0, 300)}`)
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
    expect(out).toContain('#3 "세번째" · 조회 200 · 답글 0 · 좋아요 0')
    const top = out.split('▸ 조회 가장 적은 글')[0] ?? ''
    expect(top.indexOf('#2')).toBeLessThan(top.indexOf('#1'))
    expect(top).not.toContain('#3')
    expect(out.split('▸ 조회 가장 적은 글')[1]).toContain('#3')
  })

  it('treats null metrics as unknown and notes unmeasured posts', () => {
    const out = buildWeeklyReport([row(1, 'a', m(null, null, null)), row(2, 'b', null)])
    expect(out).toContain('발행 2개 (집계 1개)')
    expect(out).toContain('답글률 계산 불가')
    expect(out).toContain('조회 -')
  })

  it('uses no emoji', () => {
    const out = buildWeeklyReport([row(1, 'a', m(10, 1)), row(2, 'b', m(5, 0))])
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('omits the format comparison when no post qualifies', () => {
    expect(buildWeeklyReport([row(1, 'a', m(10, 1))])).not.toContain('연결 글')
  })

  const exp = (postId: number, hasParts: boolean, matureViews: number | null): InsightRow => ({
    ...row(postId, `post ${postId}`, m(matureViews ?? 1, 0)),
    hasParts,
    origin: 'news',
    promptVersion: 2,
    matureViews,
  })

  it('compares chain and single news posts by the median of mature views', () => {
    const rows = [
      exp(1, true, 2),
      exp(2, true, 10),
      exp(3, true, 3),
      exp(4, false, 40),
      exp(5, false, 300),
    ]
    const out = buildWeeklyReport(rows)
    expect(out).toContain('연결 글 3개 · 조회 중앙값 3')
    expect(out).toContain('단독 글 2개 · 조회 중앙값 170')
    expect(out).toContain('최근 28일 · 발행 1일 뒤 조회')
    expect(out).toContain('표본이 작아')
  })

  it('leaves out young, digest, revived and older-voice posts', () => {
    const out = buildWeeklyReport([
      exp(1, true, 5),
      exp(2, false, null),
      { ...exp(3, true, 900), origin: 'digest' },
      { ...exp(4, false, 900), origin: 'revived' },
      { ...exp(5, false, 900), promptVersion: null },
    ])
    expect(out).toContain('연결 글 1개 · 조회 중앙값 5')
    expect(out).toContain('단독 글 없음 · 비교 불가')
  })

  it('still shows the comparison after a week without posts', () => {
    const out = buildWeeklyReport([], [exp(9, true, 6)])
    expect(out).toContain('발행된 글이 없어요')
    expect(out).toContain('연결 글 1개 · 조회 중앙값 6')
  })

  it('takes the comparison from the longer window when given', () => {
    const out = buildWeeklyReport([row(1, 'week', m(10, 0))], [exp(9, false, 70)])
    expect(out).toContain('단독 글 1개 · 조회 중앙값 70')
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
    expect(out.split('▸ 조회 가장 적은 글')[1]).toContain('#3')
    expect(out.split('▸ 조회 가장 적은 글')[1]).not.toContain('#2')
  })
})

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([40, 300])).toBe(170)
  })
})
