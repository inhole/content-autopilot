import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.ts'
import { query, transaction } from '../db/pool.ts'
import { type Approval, approveVideo } from './approve.ts'
import { prepareUpload, type UploadInfo, UploadRejected } from './probe.ts'
import { getStorage, storageKey, type VideoStorage } from './storage.ts'
import { type MetaEdit, metaProblem } from './store.ts'
import { cleanHashtags, sourceLabel, type VideoStatus } from './types.ts'

// Owner uploads through the admin console (docs/plans/video-upload.md 2, 4, 5). The row comes
// first (UPLOADING), then one file request: receive into a private temp folder, check, remux,
// record the storage key, upload, and reference the key only if the row is still UPLOADING and
// the attempt was not reclaimed meanwhile.

/** Every upload's temp folder lives here, so leftovers of a killed process can be found. */
export const UPLOAD_TMP_ROOT = join(tmpdir(), 'ca-uploads')
const TMP_MAX_AGE_MS = 60 * 60_000

export const uploadMaxBytes = () => config.VIDEO_UPLOAD_MAX_MB * 1024 * 1024

export type NewUpload = MetaEdit & { sourceUrl: string | null; originalName: string | null }

/** Creates the UPLOADING row; the title, caption and hashtags are checked like an edit. */
export async function createUpload(
  input: NewUpload,
): Promise<{ ok: true; id: number; revision: number } | { ok: false; message: string }> {
  const problem = metaProblem(input, input.sourceUrl)
  if (problem) return { ok: false, message: problem }
  const [row] = await query<{ id: number; revision: number }>(
    `insert into videos (origin, status, title, caption, hashtags, source_url, source_label,
       original_name)
     values ('upload', 'UPLOADING', $1, $2, $3, $4, $5, $6)
     returning id, revision`,
    [
      input.title.trim(),
      input.caption.trim(),
      cleanHashtags(input.hashtags),
      input.sourceUrl,
      sourceLabel(input.sourceUrl),
      input.originalName ? [...input.originalName].slice(0, 120).join('') : null,
    ],
  )
  if (!row) throw new Error('upload row insert returned nothing')
  return { ok: true, id: row.id, revision: row.revision }
}

/** Another upload is being processed: the server answers 429. */
export class UploadBusyError extends Error {
  constructor() {
    super('another upload is in progress')
    this.name = 'UploadBusyError'
  }
}

/** More bytes arrived than allowed (Content-Length lied or was absent). */
export class UploadTooLargeError extends Error {
  constructor() {
    super('upload larger than the limit')
    this.name = 'UploadTooLargeError'
  }
}

// One upload is processed at a time (disk, memory for the storage upload, ffmpeg).
let activeDir: string | null = null
let busy = false

export type ApprovalResult = { ok: true; approval: Approval } | { ok: false; error: string }

export type FileOutcome =
  | { kind: 'stored'; approval: ApprovalResult | null }
  | { kind: 'not_uploading'; status: VideoStatus | null }
  | { kind: 'rejected'; message: string }

export type FileDeps = {
  storage?: VideoStorage
  maxBytes?: number
  /** Queues the Telegram review of a stored, not approved video. */
  enqueueReview: (videoId: number) => Promise<void>
  /** Test hooks. */
  prepare?: typeof prepareUpload
  approve?: typeof approveVideo
}

/** Counts bytes and hashes them on the way to disk; fails once more than `max` arrived. */
function meter(max: number) {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > max) {
        done(new UploadTooLargeError())
        return
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })
  return { stream, size: () => size }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** The row could not take the file (definite: zero rows matched), or the attempt was reclaimed. */
class NotApplied extends Error {
  constructor(readonly why: 'not_uploading' | 'reclaimed') {
    super(why)
  }
}

/**
 * The file request of an UPLOADING row. Throws UploadBusyError (another upload runs),
 * UploadTooLargeError, and errors whose outcome is unknown (storage, DB); those leave the attempt
 * row behind for video-cleanup, never delete a file that might be referenced.
 */
export async function receiveUpload(
  videoId: number,
  body: Readable,
  opts: { approve: boolean },
  deps: FileDeps,
): Promise<FileOutcome> {
  if (busy) throw new UploadBusyError()
  busy = true
  let dir: string | null = null
  try {
    // The start mark is the expiry base: a request in progress is never expired under it.
    const [started] = await query<{ id: number }>(
      `update videos set upload_started_at = now()
       where id = $1 and status = 'UPLOADING' and origin = 'upload' returning id`,
      [videoId],
    )
    if (!started) return { kind: 'not_uploading', status: await statusOf(videoId) }

    await mkdir(UPLOAD_TMP_ROOT, { recursive: true })
    dir = await mkdtemp(join(UPLOAD_TMP_ROOT, `v${videoId}-`))
    activeDir = dir
    const input = join(dir, 'input')
    const output = join(dir, 'output.mp4')
    const m = meter(deps.maxBytes ?? uploadMaxBytes())
    await pipeline(body, m.stream, createWriteStream(input))

    let info: UploadInfo
    try {
      info = await (deps.prepare ?? prepareUpload)(input, output, m.size())
    } catch (err) {
      if (err instanceof UploadRejected) return { kind: 'rejected', message: err.message }
      throw err
    }
    const { size } = await stat(output)
    const key = storageKey(videoId, randomUUID().slice(0, 8), await sha256File(output))
    const storage = deps.storage ?? getStorage()

    // Recorded before the upload: if anything below fails without a definite answer, the key
    // stays here and video-cleanup reclaims it once nothing references it.
    await query('insert into video_upload_attempts (key, video_id) values ($1, $2)', [key, videoId])
    const url = await storage.upload(output, key)

    let revision: number
    try {
      revision = await transaction(async (q) => {
        await q("set local lock_timeout = '10s'")
        await q("set local statement_timeout = '30s'")
        const claimed = await q(
          'delete from video_upload_attempts where key = $1 and not reclaiming returning key',
          [key],
        )
        if (claimed.length === 0) throw new NotApplied('reclaimed')
        const [row] = await q<{ revision: number }>(
          `update videos set status = 'PENDING_REVIEW', video_url = $2, storage_key = $3,
             duration_ms = $4, size_bytes = $5, width = $6, height = $7, rendered_at = now(),
             storage_deleted_at = null, last_error = null, review_message_id = null,
             script_message_id = null, review_revision = null, updated_at = now()
           where id = $1 and status = 'UPLOADING' and origin = 'upload'
           returning revision`,
          [videoId, url, key, info.durationMs, size, info.width, info.height],
        )
        if (!row) throw new NotApplied('not_uploading')
        return row.revision
      })
    } catch (err) {
      if (!(err instanceof NotApplied)) throw err
      // Definite: nothing references the key. A reclaimed attempt is video-cleanup's to delete.
      if (err.why === 'not_uploading') {
        await storage.remove(key)
        await query('delete from video_upload_attempts where key = $1', [key])
      }
      return { kind: 'not_uploading', status: await statusOf(videoId) }
    }

    let approval: ApprovalResult | null = null
    if (opts.approve) {
      try {
        approval = {
          ok: true,
          approval: await (deps.approve ?? approveVideo)(videoId, { revision }),
        }
      } catch (err) {
        approval = { ok: false, error: (err as Error).message }
      }
    }
    // Not approved: the normal review. A lost enqueue is re-sent by maintenance (unsent reviews).
    if (!approval?.ok) {
      await deps.enqueueReview(videoId).catch((err: unknown) => {
        console.warn(`[video-upload] #${videoId} review enqueue failed`, (err as Error).message)
      })
    }
    return { kind: 'stored', approval }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    activeDir = null
    busy = false
  }
}

async function statusOf(videoId: number): Promise<VideoStatus | null> {
  const [row] = await query<{ status: VideoStatus }>('select status from videos where id = $1', [
    videoId,
  ])
  return row?.status ?? null
}

/** Removes temp folders a killed process left behind (older than an hour, not the active one). */
export async function cleanupUploadTemp(now = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await readdir(UPLOAD_TMP_ROOT)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const path = join(UPLOAD_TMP_ROOT, name)
    if (path === activeDir) continue
    try {
      const { mtimeMs } = await stat(path)
      if (now - mtimeMs < TMP_MAX_AGE_MS) continue
      await rm(path, { recursive: true, force: true })
      removed++
    } catch {
      // Gone meanwhile, or not ours to read: skip.
    }
  }
  return removed
}
