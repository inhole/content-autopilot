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

export interface ThreadsApi {
  createTextContainer(post: TextPost): Promise<string>
  getContainerStatus(containerId: string): Promise<{ status: ContainerStatus; error?: string }>
  publish(containerId: string): Promise<string>
  refreshToken(): Promise<{ accessToken: string; expiresInSeconds: number }>
  me(): Promise<{ id: string; username: string }>
  // Insights
  getInsights(mediaId: string): Promise<Insights>
  // Replies
  /** Top-level replies of a published post (first page only). */
  listReplies(mediaId: string): Promise<ThreadsReply[]>
  /** Publishes a text reply to a reply and returns the new media id. */
  replyTo(replyId: string, text: string): Promise<string>
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
        reverse: 'false',
      }),
    )
  }

  async replyTo(replyId: string, text: string): Promise<string> {
    const containerId = await this.createTextContainer({ text, replyToId: replyId })
    // Text containers are normally FINISHED at once; check once instead of polling.
    const { status, error } = await this.getContainerStatus(containerId)
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`reply container ${containerId} ${status}: ${error ?? 'no detail'}`)
    }
    return this.publish(containerId)
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
      `[threads dry-run] container: ${post.text.length} chars, link=${post.linkAttachment}`,
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
  async replyTo(replyId: string, text: string) {
    console.log(`[threads dry-run] reply to ${replyId}: ${text.length} chars`)
    return `dry-reply-${Date.now()}-${++this.n}`
  }
}
