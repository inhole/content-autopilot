import { z } from 'zod'
import { emptyInsights, type Insights, parseInsights } from './insights.ts'

export const THREADS_TEXT_LIMIT = 500

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED'

export type TextPost = {
  text: string
  linkAttachment?: string | null
  topicTag?: string | null
  /** Makes the post a reply to this Threads media id. */
  replyToId?: string | null
}

export type ThreadsReply = {
  id: string
  /** Missing for media-only replies. */
  text: string | null
  username: string | null
  timestamp: Date | null
  permalink: string | null
  isOwnedByMe: boolean
  hidden: boolean
}

/** One of the owner's own posts or replies, as listed by `/me/threads` and `/me/replies`. */
export type ThreadsOwnPost = {
  id: string
  /** Missing for media-only posts. */
  text: string | null
  timestamp: Date | null
}

export interface ThreadsApi {
  createTextContainer(post: TextPost): Promise<string>
  getContainerStatus(containerId: string): Promise<{ status: ContainerStatus; error?: string }>
  publish(containerId: string): Promise<string>
  refreshToken(): Promise<{ accessToken: string; expiresInSeconds: number }>
  me(): Promise<{ id: string; username: string }>
  // Insights
  getInsights(mediaId: string): Promise<Insights>
  // Replies
  /** Top-level replies of a published post, newest first (first page only). */
  listReplies(mediaId: string): Promise<ThreadsReply[]>
  // Own posts (used to recover a media id when the publish response was lost)
  /** The owner's recent top-level posts, newest first (first page only). */
  listMyThreads(): Promise<ThreadsOwnPost[]>
  /** The owner's recent replies, newest first (first page only). */
  listMyReplies(): Promise<ThreadsOwnPost[]>
}

const idResponse = z.object({ id: z.string() })
const statusResponse = z.object({
  status: z.enum(['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED']),
  error_message: z.string().optional(),
})
const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() })
const meResponse = z.object({ id: z.string(), username: z.string() })

const repliesResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().nullish(),
        username: z.string().nullish(),
        timestamp: z.string().nullish(),
        permalink: z.string().nullish(),
        is_reply_owned_by_me: z.boolean().nullish(),
        hide_status: z.string().nullish(),
      }),
    )
    .default([]),
})

const ownPostsResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().nullish(),
        timestamp: z.string().nullish(),
      }),
    )
    .default([]),
})

/** Parses a `/me/threads` or `/me/replies` response defensively, keeping the API's order. */
export function parseOwnPosts(raw: unknown): ThreadsOwnPost[] {
  return ownPostsResponse.parse(raw).data.map((r) => {
    const ts = r.timestamp ? new Date(r.timestamp) : null
    return {
      id: r.id,
      text: r.text?.trim() ? r.text : null,
      timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    }
  })
}

/** Hide statuses that mean the reply is visible to everyone. */
const VISIBLE_HIDE_STATUSES = new Set(['NOT_HUSHED', 'UNHUSHED'])

/** Parses a `/replies` response defensively: optional fields may be missing or null. */
export function parseReplies(raw: unknown): ThreadsReply[] {
  return repliesResponse.parse(raw).data.map((r) => {
    const ts = r.timestamp ? new Date(r.timestamp) : null
    return {
      id: r.id,
      text: r.text?.trim() ? r.text : null,
      username: r.username ?? null,
      timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
      permalink: r.permalink ?? null,
      isOwnedByMe: r.is_reply_owned_by_me === true,
      hidden: r.hide_status != null && !VISIBLE_HIDE_STATUSES.has(r.hide_status),
    }
  })
}

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
  }
}

export class ThreadsClient implements ThreadsApi {
  constructor(
    private readonly opts: {
      baseUrl: string
      userId: string
      accessToken: string
      fetch?: typeof fetch
    },
  ) {}

  async createTextContainer(post: TextPost): Promise<string> {
    const params: Record<string, string> = { media_type: 'TEXT', text: post.text }
    if (post.linkAttachment) params.link_attachment = post.linkAttachment
    if (post.topicTag) params.topic_tag = post.topicTag
    if (post.replyToId) params.reply_to_id = post.replyToId
    return idResponse.parse(await this.call('POST', `/${this.opts.userId}/threads`, params)).id
  }

  async getContainerStatus(containerId: string) {
    const raw = statusResponse.parse(
      await this.call('GET', `/${containerId}`, { fields: 'status,error_message' }),
    )
    return { status: raw.status, error: raw.error_message }
  }

  async publish(containerId: string): Promise<string> {
    const res = await this.call('POST', `/${this.opts.userId}/threads_publish`, {
      creation_id: containerId,
    })
    return idResponse.parse(res).id
  }

  /** Long-lived tokens can be refreshed once they are 24h old and not yet expired. */
  async refreshToken() {
    const raw = tokenResponse.parse(
      await this.call(
        'GET',
        '/refresh_access_token',
        { grant_type: 'th_refresh_token' },
        { versioned: false },
      ),
    )
    return { accessToken: raw.access_token, expiresInSeconds: raw.expires_in }
  }

  async me() {
    return meResponse.parse(await this.call('GET', '/me', { fields: 'id,username' }))
  }

  // Insights
  async getInsights(mediaId: string): Promise<Insights> {
    return parseInsights(
      await this.call('GET', `/${mediaId}/insights`, {
        metric: 'views,likes,replies,reposts,quotes,shares',
      }),
    )
  }

  // Replies
  async listReplies(mediaId: string): Promise<ThreadsReply[]> {
    return parseReplies(
      await this.call('GET', `/${mediaId}/replies`, {
        fields: 'id,text,username,timestamp,permalink,is_reply_owned_by_me,hide_status',
        // Newest first: only the first page is read, and new replies must not fall off it.
        reverse: 'true',
      }),
    )
  }

  // Own posts
  async listMyThreads(): Promise<ThreadsOwnPost[]> {
    return parseOwnPosts(
      await this.call('GET', '/me/threads', { fields: 'id,text,timestamp', limit: '25' }),
    )
  }

  async listMyReplies(): Promise<ThreadsOwnPost[]> {
    return parseOwnPosts(
      await this.call('GET', '/me/replies', { fields: 'id,text,timestamp', limit: '25' }),
    )
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
    { versioned = true } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.opts.baseUrl}${versioned ? '/v1.0' : ''}${path}`)
    const body = new URLSearchParams({ ...params, access_token: this.opts.accessToken })
    let init: RequestInit = { method, signal: AbortSignal.timeout(30_000) }
    if (method === 'GET') url.search = body.toString()
    else init = { ...init, body }
    const res = await (this.opts.fetch ?? fetch)(url, init)
    const text = await res.text()
    if (!res.ok) {
      throw new ThreadsApiError(`Threads ${method} ${path} ${res.status}`, res.status, text)
    }
    return JSON.parse(text)
  }
}

/** Logs instead of calling Meta. Used until the Threads app and token are available. */
export class DryRunThreadsClient implements ThreadsApi {
  private n = 0
  async createTextContainer(post: TextPost) {
    console.log(
      `[threads dry-run] container: ${post.text.length} chars, link=${post.linkAttachment}, replyTo=${post.replyToId}`,
    )
    return `dry-container-${Date.now()}-${++this.n}`
  }
  async getContainerStatus() {
    return { status: 'FINISHED' as const }
  }
  async publish(containerId: string) {
    console.log(`[threads dry-run] publish ${containerId}`)
    return `dry-post-${containerId}`
  }
  async refreshToken(): Promise<never> {
    throw new Error('refreshToken is not available in dry-run mode')
  }
  async me() {
    return { id: 'dry-run', username: 'dry-run' }
  }

  // Insights
  /** Dry-run posts never exist on Threads, so every metric is unknown (null), not zero. */
  async getInsights(): Promise<Insights> {
    return emptyInsights()
  }

  // Replies
  async listReplies(): Promise<ThreadsReply[]> {
    return []
  }

  // Own posts
  /** Dry-run ids come straight from publish, so they never need to be looked up. */
  async listMyThreads(): Promise<ThreadsOwnPost[]> {
    return []
  }
  async listMyReplies(): Promise<ThreadsOwnPost[]> {
    return []
  }
}
