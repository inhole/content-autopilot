import { z } from 'zod'

// Instagram API with Instagram Login (graph.instagram.com; no Facebook Page needed). Reels go out
// like Threads posts: create a container, wait for FINISHED, then media_publish
// (docs/plans/video.md 3-9).

export type ReelContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED'

export type IgMedia = {
  id: string
  caption: string | null
  timestamp: Date | null
  productType: string | null
}

export type VideoMetrics = {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
}

export interface InstagramApi {
  createReelContainer(p: { videoUrl: string; caption: string }): Promise<string>
  getContainerStatus(id: string): Promise<{ status: ReelContainerStatus; error?: string }>
  publish(containerId: string): Promise<string>
  /** Recent media of the account, newest first (first page only). */
  listRecentMedia(): Promise<IgMedia[]>
  permalink(mediaId: string): Promise<string | null>
  getInsights(mediaId: string): Promise<VideoMetrics>
  me(): Promise<{ userId: string; username: string }>
  refreshToken(): Promise<{ accessToken: string; expiresInSeconds: number }>
}

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** Meta error code; 190 = invalid or expired token. */
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'InstagramApiError'
  }
  get isAuth(): boolean {
    return this.status === 401 || this.code === 190
  }
}

const idResponse = z.object({ id: z.string() })
const containerResponse = z.object({
  status_code: z.enum(['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED']),
  status: z.string().nullish(),
})
const mediaListResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        caption: z.string().nullish(),
        timestamp: z.string().nullish(),
        media_product_type: z.string().nullish(),
      }),
    )
    .default([]),
})
const insightsResponse = z.object({
  data: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.object({ value: z.number().nullish() })).nullish(),
        total_value: z.object({ value: z.number().nullish() }).nullish(),
      }),
    )
    .default([]),
})

export function parseMediaList(raw: unknown): IgMedia[] {
  return mediaListResponse.parse(raw).data.map((m) => {
    const ts = m.timestamp ? new Date(m.timestamp) : null
    return {
      id: m.id,
      caption: m.caption ?? null,
      timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
      productType: m.media_product_type ?? null,
    }
  })
}

/** Reads `/insights`; a metric missing from the response stays null (unknown, not zero). */
export function parseReelInsights(raw: unknown): VideoMetrics {
  const out: VideoMetrics = { views: null, likes: null, comments: null, shares: null, saves: null }
  const keys: Record<string, keyof VideoMetrics> = {
    views: 'views',
    likes: 'likes',
    comments: 'comments',
    shares: 'shares',
    saved: 'saves',
  }
  for (const m of insightsResponse.parse(raw).data) {
    const key = keys[m.name]
    if (!key) continue
    const value = m.total_value?.value ?? m.values?.[0]?.value ?? null
    out[key] = value ?? null
  }
  return out
}

/** Meta error code from an error body (`{"error":{"code":190,...}}`), or null. */
export function metaErrorCode(body: string): number | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code
    return typeof code === 'number' ? code : null
  } catch {
    return null
  }
}

/**
 * The media we just published, found by exact caption among recent Reels posted after `since`.
 * Only a single match counts; anything else is unknown (null), never a guess.
 */
export function findPublishedReel(media: IgMedia[], caption: string, since: Date): string | null {
  const matches = media.filter(
    (m) =>
      m.productType === 'REELS' &&
      m.caption === caption &&
      m.timestamp !== null &&
      m.timestamp.getTime() >= since.getTime(),
  )
  return matches.length === 1 ? (matches[0]?.id ?? null) : null
}

export class InstagramClient implements InstagramApi {
  constructor(
    private readonly opts: {
      baseUrl: string
      userId: string
      accessToken: string
      fetch?: typeof fetch
    },
  ) {}

  async createReelContainer(p: { videoUrl: string; caption: string }): Promise<string> {
    const res = await this.call('POST', `/${this.opts.userId}/media`, {
      media_type: 'REELS',
      video_url: p.videoUrl,
      caption: p.caption,
      share_to_feed: 'true',
    })
    return idResponse.parse(res).id
  }

  async getContainerStatus(id: string) {
    const raw = containerResponse.parse(
      await this.call('GET', `/${id}`, { fields: 'status_code,status' }),
    )
    return { status: raw.status_code, error: raw.status ?? undefined }
  }

  async publish(containerId: string): Promise<string> {
    const res = await this.call('POST', `/${this.opts.userId}/media_publish`, {
      creation_id: containerId,
    })
    return idResponse.parse(res).id
  }

  async listRecentMedia(): Promise<IgMedia[]> {
    return parseMediaList(
      await this.call('GET', `/${this.opts.userId}/media`, {
        fields: 'id,caption,timestamp,media_product_type',
        limit: '25',
      }),
    )
  }

  async permalink(mediaId: string): Promise<string | null> {
    const raw = z
      .object({ permalink: z.string().nullish() })
      .parse(await this.call('GET', `/${mediaId}`, { fields: 'permalink' }))
    return raw.permalink ?? null
  }

  async getInsights(mediaId: string): Promise<VideoMetrics> {
    return parseReelInsights(
      await this.call('GET', `/${mediaId}/insights`, {
        metric: 'views,likes,comments,shares,saved',
      }),
    )
  }

  async me() {
    const raw = z
      .object({ user_id: z.union([z.string(), z.number()]), username: z.string() })
      .parse(await this.call('GET', '/me', { fields: 'user_id,username' }))
    return { userId: String(raw.user_id), username: raw.username }
  }

  /** Long-lived tokens refresh once they are 24h old and not expired. The path is unversioned. */
  async refreshToken() {
    const raw = z
      .object({ access_token: z.string(), expires_in: z.number() })
      .parse(
        await this.call(
          'GET',
          '/refresh_access_token',
          { grant_type: 'ig_refresh_token' },
          { versioned: false },
        ),
      )
    return { accessToken: raw.access_token, expiresInSeconds: raw.expires_in }
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
    { versioned = true } = {},
  ): Promise<unknown> {
    const base = versioned ? this.opts.baseUrl : new URL(this.opts.baseUrl).origin
    const url = new URL(`${base}${path}`)
    const body = new URLSearchParams({ ...params, access_token: this.opts.accessToken })
    let init: RequestInit = { method, signal: AbortSignal.timeout(30_000) }
    if (method === 'GET') url.search = body.toString()
    else init = { ...init, body }
    const res = await (this.opts.fetch ?? fetch)(url, init)
    const text = await res.text()
    if (!res.ok) {
      throw new InstagramApiError(
        `Instagram ${method} ${path} ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        text,
        metaErrorCode(text),
      )
    }
    return JSON.parse(text)
  }
}

/** Logs instead of calling Instagram (VIDEO_PUBLISH_DRY_RUN). Ids start with `dry-`. */
export class DryRunInstagram implements InstagramApi {
  private n = 0
  async createReelContainer(p: { videoUrl: string; caption: string }) {
    console.log(`[instagram dry-run] container: ${p.videoUrl}, caption ${p.caption.length} chars`)
    return `dry-ig-container-${Date.now()}-${++this.n}`
  }
  async getContainerStatus() {
    return { status: 'FINISHED' as const }
  }
  async publish(containerId: string) {
    console.log(`[instagram dry-run] publish ${containerId}`)
    return `dry-ig-${containerId}`
  }
  async listRecentMedia(): Promise<IgMedia[]> {
    return []
  }
  async permalink() {
    return null
  }
  async getInsights(): Promise<VideoMetrics> {
    return { views: null, likes: null, comments: null, shares: null, saves: null }
  }
  async me() {
    return { userId: 'dry-run', username: 'dry-run' }
  }
  async refreshToken(): Promise<never> {
    throw new Error('refreshToken is not available in dry-run mode')
  }
}
