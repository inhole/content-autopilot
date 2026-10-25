import { z } from 'zod'
import type { VideoMetrics } from './instagram.ts'

// YouTube Data API v3: resumable `videos.insert` for Shorts (docs/plans/video.md 3-9). The session
// URL is saved before any bytes go out, so a retry asks the session what it already has instead of
// uploading a second copy.

export type UploadMeta = {
  title: string
  description: string
  tags: string[]
  privacy: 'public' | 'unlisted' | 'private'
  sizeBytes: number
}

export type UploadState =
  | { kind: 'complete'; videoId: string }
  /** `received` bytes are stored; continue from there. */
  | { kind: 'incomplete'; received: number }
  /** 404/410: the session expired or never existed. Says nothing about an earlier upload. */
  | { kind: 'gone' }

export type YouTubeVideoStatus = {
  uploadStatus: string
  privacyStatus: string | null
  failureReason: string | null
  rejectionReason: string | null
}

export interface YouTubeApi {
  startUpload(meta: UploadMeta): Promise<string>
  uploadStatus(sessionUrl: string, sizeBytes: number): Promise<UploadState>
  upload(sessionUrl: string, bytes: Buffer, from: number): Promise<UploadState>
  /** A recent upload of the channel carrying `tag`, or null. */
  findUploadByTag(tag: string): Promise<string | null>
  videoStatus(videoId: string): Promise<YouTubeVideoStatus | null>
  statistics(videoId: string): Promise<VideoMetrics | null>
  channel(): Promise<{ id: string; title: string }>
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'YouTubeApiError'
  }
  get isAuth(): boolean {
    return this.status === 401
  }
}

/** The refresh token was revoked or expired (`invalid_grant`): `youtube:auth` must run again. */
export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YouTubeAuthError'
  }
}

/** Upload tag that identifies a publication row on the channel (`capub<id>`). */
export const publicationTag = (publicationId: number) => `capub${publicationId}`

/** Bytes stored so far from a 308 `Range: bytes=0-N` header (none = 0). */
export function receivedFromRange(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null
  return m ? Number(m[1]) + 1 : 0
}

const videoIdResponse = z.object({ id: z.string() })

/** Interprets the response of an upload PUT or a status query. */
export async function readUploadResponse(res: Response): Promise<UploadState> {
  if (res.status === 200 || res.status === 201) {
    return { kind: 'complete', videoId: videoIdResponse.parse(await res.json()).id }
  }
  if (res.status === 308) {
    return { kind: 'incomplete', received: receivedFromRange(res.headers.get('range')) }
  }
  if (res.status === 404 || res.status === 410) return { kind: 'gone' }
  const body = await res.text()
  throw new YouTubeApiError(`YouTube upload ${res.status}: ${body.slice(0, 300)}`, res.status, body)
}

const statusResponse = z.object({
  items: z
    .array(
      z.object({
        status: z
          .object({
            uploadStatus: z.string(),
            privacyStatus: z.string().nullish(),
            failureReason: z.string().nullish(),
            rejectionReason: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
})

export function parseVideoStatus(raw: unknown): YouTubeVideoStatus | null {
  const s = statusResponse.parse(raw).items[0]?.status
  if (!s) return null
  return {
    uploadStatus: s.uploadStatus,
    privacyStatus: s.privacyStatus ?? null,
    failureReason: s.failureReason ?? null,
    rejectionReason: s.rejectionReason ?? null,
  }
}

const statsResponse = z.object({
  items: z
    .array(
      z.object({
        statistics: z
          .object({
            viewCount: z.string().nullish(),
            likeCount: z.string().nullish(),
            commentCount: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
})

/** Statistics come as strings; a hidden count (likes can be hidden) stays null. */
export function parseStatistics(raw: unknown): VideoMetrics | null {
  const s = statsResponse.parse(raw).items[0]?.statistics
  if (!s) return null
  const num = (v: string | null | undefined) => (v == null ? null : Number(v))
  return {
    views: num(s.viewCount),
    likes: num(s.likeCount),
    comments: num(s.commentCount),
    shares: null,
    saves: null,
  }
}

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'

export class YouTubeClient implements YouTubeApi {
  constructor(
    private readonly opts: {
      accessToken: () => Promise<string>
      fetch?: typeof fetch
    },
  ) {}

  private get f() {
    return this.opts.fetch ?? fetch
  }

  private async headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${await this.opts.accessToken()}`, ...extra }
  }

  async startUpload(meta: UploadMeta): Promise<string> {
    const url = `${UPLOAD}?uploadType=resumable&part=snippet,status`
    const res = await this.f(url, {
      method: 'POST',
      headers: await this.headers({
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(meta.sizeBytes),
        'X-Upload-Content-Type': 'video/mp4',
      }),
      body: JSON.stringify({
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          // Science & Technology
          categoryId: '28',
        },
        status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new YouTubeApiError(
        `YouTube start upload ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        body,
      )
    }
    const location = res.headers.get('location')
    if (!location) throw new Error('YouTube start upload returned no session URL')
    return location
  }

  async uploadStatus(sessionUrl: string, sizeBytes: number): Promise<UploadState> {
    const res = await this.f(sessionUrl, {
      method: 'PUT',
      headers: await this.headers({ 'Content-Range': `bytes */${sizeBytes}` }),
      body: new Uint8Array(0),
      signal: AbortSignal.timeout(30_000),
    })
    return readUploadResponse(res)
  }

  async upload(sessionUrl: string, bytes: Buffer, from: number): Promise<UploadState> {
    const extra: Record<string, string> = { 'Content-Type': 'video/mp4' }
    if (from > 0) extra['Content-Range'] = `bytes ${from}-${bytes.length - 1}/${bytes.length}`
    const res = await this.f(sessionUrl, {
      method: 'PUT',
      headers: await this.headers(extra),
      body: new Uint8Array(bytes.subarray(from)),
      signal: AbortSignal.timeout(5 * 60_000),
    })
    return readUploadResponse(res)
  }

  async findUploadByTag(tag: string): Promise<string | null> {
    const channel = z
      .object({
        items: z
          .array(
            z.object({
              contentDetails: z.object({
                relatedPlaylists: z.object({ uploads: z.string() }),
              }),
            }),
          )
          .default([]),
      })
      .parse(await this.get('/channels', { part: 'contentDetails', mine: 'true' }))
    const uploads = channel.items[0]?.contentDetails.relatedPlaylists.uploads
    if (!uploads) return null
    const items = z
      .object({
        items: z.array(z.object({ contentDetails: z.object({ videoId: z.string() }) })).default([]),
      })
      .parse(
        await this.get('/playlistItems', {
          part: 'contentDetails',
          playlistId: uploads,
          maxResults: '25',
        }),
      )
    const ids = items.items.map((i) => i.contentDetails.videoId)
    if (ids.length === 0) return null
    const videos = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string(),
              snippet: z.object({ tags: z.array(z.string()).nullish() }).nullish(),
            }),
          )
          .default([]),
      })
      .parse(await this.get('/videos', { part: 'snippet', id: ids.join(',') }))
    const found = videos.items.filter((v) => v.snippet?.tags?.includes(tag))
    return found.length === 1 ? (found[0]?.id ?? null) : null
  }

  async videoStatus(videoId: string): Promise<YouTubeVideoStatus | null> {
    return parseVideoStatus(await this.get('/videos', { part: 'status', id: videoId }))
  }

  async statistics(videoId: string): Promise<VideoMetrics | null> {
    return parseStatistics(await this.get('/videos', { part: 'statistics', id: videoId }))
  }

  async channel() {
    const raw = z
      .object({
        items: z
          .array(z.object({ id: z.string(), snippet: z.object({ title: z.string() }) }))
          .default([]),
      })
      .parse(await this.get('/channels', { part: 'snippet', mine: 'true' }))
    const c = raw.items[0]
    if (!c) throw new Error('this Google account has no YouTube channel')
    return { id: c.id, title: c.snippet.title }
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${API}${path}`)
    url.search = new URLSearchParams(params).toString()
    const res = await this.f(url, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new YouTubeApiError(
        `YouTube GET ${path} ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        text,
      )
    }
    return JSON.parse(text)
  }
}

/** Logs instead of calling YouTube (VIDEO_PUBLISH_DRY_RUN). Video ids start with `dry-`. */
export class DryRunYouTube implements YouTubeApi {
  private n = 0
  async startUpload(meta: UploadMeta) {
    console.log(`[youtube dry-run] session for "${meta.title}" (${meta.sizeBytes} bytes)`)
    return `dry-session-${Date.now()}-${++this.n}`
  }
  async uploadStatus(): Promise<UploadState> {
    return { kind: 'incomplete', received: 0 }
  }
  async upload(sessionUrl: string): Promise<UploadState> {
    console.log(`[youtube dry-run] upload ${sessionUrl}`)
    return { kind: 'complete', videoId: `dry-yt-${sessionUrl}` }
  }
  async findUploadByTag() {
    return null
  }
  async videoStatus(): Promise<YouTubeVideoStatus> {
    return {
      uploadStatus: 'processed',
      privacyStatus: null,
      failureReason: null,
      rejectionReason: null,
    }
  }
  async statistics() {
    return null
  }
  async channel() {
    return { id: 'dry-run', title: 'dry-run' }
  }
}
