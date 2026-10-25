import { describe, expect, it } from 'vitest'
import { buildVideoReport } from '../src/video/insights.ts'
import {
  findPublishedReel,
  InstagramApiError,
  InstagramClient,
  metaErrorCode,
  parseReelInsights,
} from '../src/video/instagram.ts'
import {
  classify,
  decideAfterFailure,
  FinalPublishError,
  judgeShortStatus,
} from '../src/video/publish.ts'
import {
  parseStatistics,
  parseVideoStatus,
  readUploadResponse,
  receivedFromRange,
  YouTubeApiError,
  YouTubeAuthError,
  YouTubeClient,
} from '../src/video/youtube.ts'

describe('Instagram parsing', () => {
  it('reads insights from values or total_value; missing metrics stay null', () => {
    expect(
      parseReelInsights({
        data: [
          { name: 'views', values: [{ value: 120 }] },
          { name: 'likes', total_value: { value: 7 } },
          { name: 'saved', values: [{ value: 2 }] },
          { name: 'reach', values: [{ value: 99 }] },
        ],
      }),
    ).toEqual({ views: 120, likes: 7, comments: null, shares: null, saves: 2 })
  })

  it('reads the Meta error code', () => {
    expect(metaErrorCode('{"error":{"code":190,"message":"x"}}')).toBe(190)
    expect(metaErrorCode('not json')).toBeNull()
    expect(new InstagramApiError('m', 400, '', 190).isAuth).toBe(true)
    expect(new InstagramApiError('m', 500, '', 2).isAuth).toBe(false)
  })

  it('recovers a media id only from exactly one matching Reel after the attempt', () => {
    const since = new Date('2026-10-24T10:00:00Z')
    const reel = (id: string, caption: string, at: string, type = 'REELS') => ({
      id,
      caption,
      timestamp: new Date(at),
      productType: type,
    })
    const media = [
      reel('new', 'cap', '2026-10-24T10:05:00Z'),
      reel('old', 'cap', '2026-10-20T10:00:00Z'),
      reel('feed', 'cap', '2026-10-24T10:06:00Z', 'FEED'),
    ]
    expect(findPublishedReel(media, 'cap', since)).toBe('new')
    expect(
      findPublishedReel([...media, reel('dup', 'cap', '2026-10-24T10:07:00Z')], 'cap', since),
    ).toBeNull()
    expect(findPublishedReel(media, 'other', since)).toBeNull()
  })

  it('sends REELS containers with the video URL and caption', async () => {
    const calls: { url: string; body: string }[] = []
    const client = new InstagramClient({
      baseUrl: 'https://graph.instagram.com/v24.0',
      userId: '42',
      accessToken: 'tok',
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), body: String(init.body) })
        return new Response('{"id":"c1"}')
      }) as unknown as typeof fetch,
    })
    expect(await client.createReelContainer({ videoUrl: 'https://s/v.mp4', caption: '캡션' })).toBe(
      'c1',
    )
    expect(calls[0]?.url).toBe('https://graph.instagram.com/v24.0/42/media')
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get('media_type')).toBe('REELS')
    expect(body.get('video_url')).toBe('https://s/v.mp4')
    expect(body.get('share_to_feed')).toBe('true')
  })

  it('refreshes the token on the unversioned path', async () => {
    let seen = ''
    const client = new InstagramClient({
      baseUrl: 'https://graph.instagram.com/v24.0',
      userId: '42',
      accessToken: 'tok',
      fetch: (async (url: URL) => {
        seen = String(url)
        return new Response('{"access_token":"new","expires_in":5184000}')
      }) as unknown as typeof fetch,
    })
    expect(await client.refreshToken()).toEqual({ accessToken: 'new', expiresInSeconds: 5184000 })
    expect(seen.startsWith('https://graph.instagram.com/refresh_access_token?')).toBe(true)
    expect(seen).toContain('grant_type=ig_refresh_token')
  })
})

describe('YouTube resumable upload', () => {
  it('reads the received byte count from a 308 Range header', () => {
    expect(receivedFromRange('bytes=0-999')).toBe(1000)
    expect(receivedFromRange(null)).toBe(0)
  })

  it('interprets upload responses', async () => {
    expect(await readUploadResponse(new Response('{"id":"vid"}', { status: 201 }))).toEqual({
      kind: 'complete',
      videoId: 'vid',
    })
    expect(
      await readUploadResponse(
        new Response(null, { status: 308, headers: { Range: 'bytes=0-9' } }),
      ),
    ).toEqual({ kind: 'incomplete', received: 10 })
    expect(await readUploadResponse(new Response('', { status: 404 }))).toEqual({ kind: 'gone' })
    await expect(readUploadResponse(new Response('boom', { status: 500 }))).rejects.toBeInstanceOf(
      YouTubeApiError,
    )
  })

  it('starts a session with metadata and resumes from the stored offset', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; size: number }[] =
      []
    const client = new YouTubeClient({
      accessToken: async () => 'at',
      fetch: (async (url: string, init: RequestInit) => {
        const body = init.body as Uint8Array | string | undefined
        calls.push({
          url: String(url),
          method: String(init.method),
          headers: init.headers as Record<string, string>,
          size: typeof body === 'string' ? body.length : (body?.byteLength ?? 0),
        })
        if (init.method === 'POST') {
          return new Response('', { status: 200, headers: { Location: 'https://upload/session' } })
        }
        return new Response('{"id":"yt1"}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    const session = await client.startUpload({
      title: 't',
      description: 'd',
      tags: ['capub1'],
      privacy: 'public',
      sizeBytes: 10,
    })
    expect(session).toBe('https://upload/session')
    expect(calls[0]?.headers['X-Upload-Content-Length']).toBe('10')
    expect(await client.upload(session, Buffer.alloc(10), 4)).toEqual({
      kind: 'complete',
      videoId: 'yt1',
    })
    expect(calls[1]?.headers['Content-Range']).toBe('bytes 4-9/10')
    expect(calls[1]?.size).toBe(6)
  })

  it('parses status and statistics', () => {
    expect(
      parseVideoStatus({
        items: [{ status: { uploadStatus: 'processed', privacyStatus: 'public' } }],
      }),
    ).toEqual({
      uploadStatus: 'processed',
      privacyStatus: 'public',
      failureReason: null,
      rejectionReason: null,
    })
    expect(parseVideoStatus({ items: [] })).toBeNull()
    expect(
      parseStatistics({ items: [{ statistics: { viewCount: '12', commentCount: '1' } }] }),
    ).toEqual({
      views: 12,
      likes: null,
      comments: 1,
      shares: null,
      saves: null,
    })
  })
})

describe('judgeShortStatus', () => {
  const s = (uploadStatus: string, privacyStatus: string | null = 'public') => ({
    uploadStatus,
    privacyStatus,
    failureReason: null,
    rejectionReason: null,
  })
  it('waits while processing, then reports problems once', () => {
    expect(judgeShortStatus(s('uploaded'), 'public', 60_000)).toEqual({
      done: false,
      problem: null,
    })
    expect(judgeShortStatus(s('processed'), 'public', 60_000)).toEqual({
      done: true,
      problem: null,
    })
    expect(judgeShortStatus(s('processed', 'private'), 'public', 60_000).problem).toMatch(/private/)
    expect(judgeShortStatus(s('rejected'), 'public', 60_000).problem).toMatch(/처리 실패/)
    expect(judgeShortStatus(s('uploaded'), 'public', 25 * 3600_000).problem).toMatch(/24시간/)
    expect(judgeShortStatus(null, 'public', 60_000)).toEqual({ done: false, problem: null })
  })
})

describe('publish failure handling', () => {
  it('treats auth errors as final and everything else as retryable', () => {
    expect(classify(new YouTubeAuthError('x'))?.kind).toBe('auth')
    expect(classify(new InstagramApiError('x', 400, '', 190))?.kind).toBe('auth')
    expect(classify(new YouTubeApiError('x', 401, ''))?.kind).toBe('auth')
    expect(classify(new FinalPublishError('x', 'session'))?.kind).toBe('session')
    expect(classify(new Error('timeout'))).toBeNull()
    expect(classify(new InstagramApiError('x', 500, '', 2))).toBeNull()
  })

  it('lets a PUBLISHED container win and gives unknown outcomes extra attempts', () => {
    expect(decideAfterFailure({ attempts: 3, containerStatus: 'PUBLISHED' })).toBe('published')
    expect(decideAfterFailure({ attempts: 2, containerStatus: null })).toBe('retry')
    expect(decideAfterFailure({ attempts: 3, containerStatus: null })).toBe('failed')
    expect(decideAfterFailure({ attempts: 4, containerStatus: 'unknown' })).toBe('retry')
    expect(decideAfterFailure({ attempts: 6, containerStatus: 'unknown' })).toBe('failed')
  })
})

describe('buildVideoReport', () => {
  it('is empty without videos', () => {
    expect(buildVideoReport([])).toEqual([])
  })

  it('sums the latest views per platform and names the top video', () => {
    const lines = buildVideoReport([
      { platform: 'REELS', title: '첫 영상', views: 100, likes: 3 },
      { platform: 'REELS', title: '둘째', views: null, likes: null },
      { platform: 'SHORTS', title: '첫 영상', views: 250, likes: 9 },
    ])
    expect(lines).toEqual([
      '',
      '🎬 영상 (최근 7일)',
      'Instagram Reels 2개 — 조회 100 (집계 1개)',
      'YouTube Shorts 1개 — 조회 250',
      '가장 많이 본 영상: "첫 영상" (YouTube Shorts, 👁 250)',
    ])
  })
})
