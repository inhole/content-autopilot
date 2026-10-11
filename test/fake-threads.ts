import type {
  ContainerStatus,
  TextPost,
  ThreadsApi,
  ThreadsOwnPost,
} from '../src/threads/client.ts'

type Container = { post: TextPost; status: ContainerStatus; mediaId: string | null }

/**
 * Stateful in-memory Threads. Published top-level posts and replies show up (newest first) in
 * listMyThreads / listMyReplies, like the real `/me/threads` and `/me/replies`.
 */
export class FakeThreads implements ThreadsApi {
  readonly containers = new Map<string, Container>()
  /** Every createTextContainer call, in order. */
  readonly created: { id: string; post: TextPost }[] = []
  /** Every publish call (container ids), in order. */
  readonly publishCalls: string[] = []
  private threads: ThreadsOwnPost[] = []
  private replies: ThreadsOwnPost[] = []
  private n = 0

  /** Texts whose publish succeeds on Threads but whose response is lost (the call throws). */
  loseResponseFor = new Set<string>()
  /** Texts whose container creation fails with an API error. */
  failCreateFor = new Set<string>()
  /** Makes listMyThreads / listMyReplies throw. */
  listingFails = false
  /** Pauses createTextContainer so tests can interleave concurrent callers. */
  createDelayMs = 0

  async createTextContainer(post: TextPost) {
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs))
    if (this.failCreateFor.has(post.text)) throw new Error('Threads POST /threads 500')
    const id = `c${++this.n}`
    this.containers.set(id, { post, status: 'FINISHED', mediaId: null })
    this.created.push({ id, post })
    return id
  }

  async getContainerStatus(containerId: string) {
    const c = this.containers.get(containerId)
    if (!c) throw new Error(`unknown container ${containerId}`)
    return { status: c.status }
  }

  async publish(containerId: string) {
    this.publishCalls.push(containerId)
    const c = this.containers.get(containerId)
    if (!c) throw new Error(`unknown container ${containerId}`)
    c.status = 'PUBLISHED'
    c.mediaId = `m${++this.n}`
    const entry = { id: c.mediaId, text: c.post.text, timestamp: new Date() }
    ;(c.post.replyToId ? this.replies : this.threads).unshift(entry)
    if (this.loseResponseFor.has(c.post.text)) throw new Error('fetch failed')
    return c.mediaId
  }

  async listMyThreads() {
    if (this.listingFails) throw new Error('Threads GET /me/threads 500')
    return [...this.threads]
  }

  async listMyReplies() {
    if (this.listingFails) throw new Error('Threads GET /me/replies 500')
    return [...this.replies]
  }

  /** Seeds an already-live main post (e.g. one whose id the database never learned). */
  addLiveThread(text: string): string {
    const id = `m${++this.n}`
    this.threads.unshift({ id, text, timestamp: new Date() })
    return id
  }

  async refreshToken(): Promise<never> {
    throw new Error('not used')
  }
  async me(): Promise<never> {
    throw new Error('not used')
  }
  async getInsights(): Promise<never> {
    throw new Error('not used')
  }
  async listReplies() {
    return []
  }
}
