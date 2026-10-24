import type {
  IgMedia,
  InstagramApi,
  ReelContainerStatus,
  VideoMetrics,
} from '../src/video/instagram.ts'
import type { VideoStorage } from '../src/video/storage.ts'
import type {
  UploadMeta,
  UploadState,
  YouTubeApi,
  YouTubeVideoStatus,
} from '../src/video/youtube.ts'

/** In-memory Instagram: containers finish after `finishAfterPolls` status checks. */
export class FakeInstagram implements InstagramApi {
  readonly containers = new Map<
    string,
    { caption: string; status: ReelContainerStatus; polls: number }
  >()
  readonly created: string[] = []
  readonly publishCalls: string[] = []
  media: IgMedia[] = []
  finishAfterPolls = 0
  /** publish() succeeds on Instagram but the response is lost (the call throws). */
  loseResponse = false
  /** Error thrown by createReelContainer. */
  createError: Error | null = null
  /** Containers never finish (stay IN_PROGRESS). */
  neverFinish = false
  private n = 0

  async createReelContainer(p: { videoUrl: string; caption: string }) {
    if (this.createError) throw this.createError
    const id = `c${++this.n}`
    this.containers.set(id, { caption: p.caption, status: 'IN_PROGRESS', polls: 0 })
    this.created.push(id)
    return id
  }
  async getContainerStatus(id: string) {
    const c = this.containers.get(id)
    if (!c) return { status: 'EXPIRED' as const }
    if (c.status === 'IN_PROGRESS' && !this.neverFinish) {
      if (c.polls++ >= this.finishAfterPolls) c.status = 'FINISHED'
    }
    return { status: c.status }
  }
  async publish(containerId: string) {
    this.publishCalls.push(containerId)
    const c = this.containers.get(containerId)
    if (!c || c.status !== 'FINISHED') throw new Error('not finished')
    c.status = 'PUBLISHED'
    const id = `m${containerId}`
    this.media.unshift({ id, caption: c.caption, timestamp: new Date(), productType: 'REELS' })
    if (this.loseResponse) throw new Error('socket hang up')
    return id
  }
  async listRecentMedia() {
    return this.media
  }
  async permalink(mediaId: string) {
    return `https://instagram.com/reel/${mediaId}`
  }
  async getInsights(): Promise<VideoMetrics> {
    return { views: 10, likes: 1, comments: 0, shares: 0, saves: 0 }
  }
  async me() {
    return { userId: '1', username: 'me' }
  }
  async refreshToken() {
    return { accessToken: 'new', expiresInSeconds: 100 }
  }
}

/** In-memory YouTube resumable uploads. */
export class FakeYouTube implements YouTubeApi {
  readonly sessions = new Map<
    string,
    { meta: UploadMeta; received: number; videoId: string | null }
  >()
  readonly uploads: { session: string; from: number }[] = []
  readonly videos: { id: string; tags: string[] }[] = []
  /** Sessions that answer 404 from now on. */
  readonly expired = new Set<string>()
  /** The next upload stores this many bytes and then fails (network drop). */
  dropAfterBytes: number | null = null
  /** The upload completes but the response is lost. */
  loseResponse = false
  status: YouTubeVideoStatus | null = {
    uploadStatus: 'processed',
    privacyStatus: 'public',
    failureReason: null,
    rejectionReason: null,
  }
  private n = 0

  async startUpload(meta: UploadMeta) {
    const url = `https://upload/s${++this.n}`
    this.sessions.set(url, { meta, received: 0, videoId: null })
    return url
  }
  async uploadStatus(sessionUrl: string): Promise<UploadState> {
    const s = this.sessions.get(sessionUrl)
    if (!s || this.expired.has(sessionUrl)) return { kind: 'gone' }
    if (s.videoId) return { kind: 'complete', videoId: s.videoId }
    return { kind: 'incomplete', received: s.received }
  }
  async upload(sessionUrl: string, bytes: Buffer, from: number): Promise<UploadState> {
    this.uploads.push({ session: sessionUrl, from })
    const s = this.sessions.get(sessionUrl)
    if (!s || this.expired.has(sessionUrl)) return { kind: 'gone' }
    if (from !== s.received) throw new Error(`resume from ${from}, stored ${s.received}`)
    if (this.dropAfterBytes !== null) {
      s.received = this.dropAfterBytes
      this.dropAfterBytes = null
      throw new Error('connection reset')
    }
    s.received = bytes.length
    s.videoId = `yt${this.videos.length + 1}`
    this.videos.push({ id: s.videoId, tags: s.meta.tags })
    if (this.loseResponse) {
      this.loseResponse = false
      throw new Error('socket hang up')
    }
    return { kind: 'complete', videoId: s.videoId }
  }
  async findUploadByTag(tag: string) {
    const found = this.videos.filter((v) => v.tags.includes(tag))
    return found.length === 1 ? (found[0]?.id ?? null) : null
  }
  async videoStatus() {
    return this.status
  }
  async statistics(): Promise<VideoMetrics> {
    return { views: 50, likes: 5, comments: 1, shares: null, saves: null }
  }
  async channel() {
    return { id: 'UC1', title: 'me' }
  }
}

/** Storage that keeps uploads in memory and records deletions. */
export class FakeStorage implements VideoStorage {
  readonly kind = 'supabase' as const
  readonly files = new Map<string, Buffer>()
  readonly removed: string[] = []
  async upload(_path: string, key: string) {
    this.files.set(key, Buffer.from(`video:${key}`))
    return `https://storage.test/${key}`
  }
  async remove(key: string) {
    this.removed.push(key)
    this.files.delete(key)
  }
  async download(url: string) {
    const key = url.replace('https://storage.test/', '')
    const file = this.files.get(key)
    if (!file) throw new Error(`no file ${key}`)
    return file
  }
}
