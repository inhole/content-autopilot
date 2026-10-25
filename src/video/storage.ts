import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from '../config.ts'

// Where rendered videos live (docs/plans/video.md 3-10). Instagram fetches the file from a public
// https URL, so production uses a public Supabase Storage bucket; `local` is for development.

export interface VideoStorage {
  readonly kind: 'local' | 'supabase'
  /** Stores the file under `key` and returns its URL. Retrying the same key is safe. */
  upload(localPath: string, key: string): Promise<string>
  /** Deletes the object; deleting a missing object is not an error. */
  remove(key: string): Promise<void>
  /** Reads the stored bytes back (for the Telegram upload and YouTube). */
  download(url: string): Promise<Buffer>
}

/** `v<videoId>/<render run id>-<sha256 prefix>.mp4`: a fresh name per render run. */
export const storageKey = (videoId: number, runId: string, sha256: string) =>
  `v${videoId}/${runId}-${sha256.slice(0, 16)}.mp4`

export class LocalStorage implements VideoStorage {
  readonly kind = 'local' as const
  constructor(private readonly root: string) {}
  async upload(localPath: string, key: string): Promise<string> {
    const target = resolve(this.root, key)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(localPath, target)
    return pathToFileURL(target).toString()
  }
  async remove(key: string): Promise<void> {
    await rm(resolve(this.root, key), { force: true })
  }
  async download(url: string): Promise<Buffer> {
    return readFile(url.startsWith('file:') ? fileURLToPath(url) : url)
  }
}

export class SupabaseStorage implements VideoStorage {
  readonly kind = 'supabase' as const
  constructor(
    private readonly opts: {
      url: string
      serviceKey: string
      bucket: string
      fetch?: typeof fetch
    },
  ) {}

  private get f() {
    return this.opts.fetch ?? fetch
  }

  publicUrl(key: string): string {
    return `${this.opts.url}/storage/v1/object/public/${this.opts.bucket}/${key}`
  }

  async upload(localPath: string, key: string): Promise<string> {
    const res = await this.f(`${this.opts.url}/storage/v1/object/${this.opts.bucket}/${key}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.serviceKey}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'false',
        'Cache-Control': 'max-age=31536000',
      },
      body: await readFile(localPath),
      signal: AbortSignal.timeout(5 * 60_000),
    })
    const text = await res.text()
    // Keys are unique per render run, so "already exists" means our own earlier attempt landed.
    if (!res.ok && !isDuplicate(res.status, text)) {
      throw new Error(`Supabase upload ${res.status}: ${text.slice(0, 300)}`)
    }
    return this.publicUrl(key)
  }

  async remove(key: string): Promise<void> {
    const res = await this.f(`${this.opts.url}/storage/v1/object/${this.opts.bucket}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.opts.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [key] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok)
      throw new Error(`Supabase delete ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  async download(url: string): Promise<Buffer> {
    const res = await this.f(url, { signal: AbortSignal.timeout(5 * 60_000) })
    if (!res.ok) throw new Error(`video download ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}

/** Supabase answers a duplicate key with 409, or with 400 and a body saying 409/Duplicate. */
export function isDuplicate(status: number, body: string): boolean {
  return status === 409 || (status === 400 && /Duplicate|already exists|"409"/i.test(body))
}

let storage: VideoStorage | undefined

export function getStorage(): VideoStorage {
  if (storage) return storage
  if (config.VIDEO_STORAGE === 'supabase') {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
      throw new Error('VIDEO_STORAGE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
    }
    storage = new SupabaseStorage({
      url: config.SUPABASE_URL,
      serviceKey: config.SUPABASE_SERVICE_KEY,
      bucket: config.VIDEO_STORAGE_BUCKET,
    })
  } else {
    storage = new LocalStorage(resolve(config.VIDEO_LOCAL_DIR))
  }
  return storage
}

/** For tests. */
export function setStorage(next: VideoStorage | undefined): void {
  storage = next
}
