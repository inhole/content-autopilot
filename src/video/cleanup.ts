import { query } from '../db/pool.ts'
import { getStorage, type VideoStorage } from './storage.ts'

// Deletes stored video files that nothing can need any more (docs/plans/video.md 3-10): videos
// that ended without going out (3 days later) and published ones (14 days later). APPROVED videos
// (scheduled, publishing or failed and retryable) are never touched.

const ENDED_DAYS = 3
const PUBLISHED_DAYS = 14

// `video_url` is not part of the condition: it is cleared before the delete (see below), so a
// delete that failed is tried again on the next run.
const DELETABLE = `storage_key is not null and storage_deleted_at is null
  and ((status in ('REJECTED', 'EXPIRED', 'FAILED')
        and updated_at < $1::timestamptz - make_interval(days => $2))
    or (status = 'PUBLISHED' and published_at < $1::timestamptz - make_interval(days => $3)))`

export async function cleanupVideoFiles(
  now = new Date(),
  storage: VideoStorage = getStorage(),
): Promise<{ deleted: number; failed: number }> {
  const params = [now, ENDED_DAYS, PUBLISHED_DAYS]
  const rows = await query<{ id: number; storage_key: string }>(
    `select id, storage_key from videos where ${DELETABLE} order by id limit 50`,
    params,
  )
  const result = { deleted: 0, failed: 0 }
  for (const r of rows) {
    // Retire the file in the same UPDATE that re-checks the condition, so a FAILED or EXPIRED
    // video restarted meanwhile either keeps it (the check fails) or can no longer reuse it
    // (`skipRender` needs a video_url) and renders a new file.
    const retired = await query(
      `update videos set video_url = null
       where id = $4 and storage_key = $5 and ${DELETABLE}
       returning id`,
      [...params, r.id, r.storage_key],
    )
    if (retired.length === 0) continue
    try {
      await storage.remove(r.storage_key)
    } catch (err) {
      console.warn(`[video-cleanup] #${r.id} delete failed: ${(err as Error).message}`)
      result.failed++
      continue
    }
    // Recorded only after the delete succeeded.
    await query(
      `update videos set storage_deleted_at = now()
       where id = $1 and storage_key = $2 and storage_deleted_at is null`,
      [r.id, r.storage_key],
    )
    result.deleted++
  }
  return result
}

const ATTEMPT_MAX_AGE_HOURS = 1

/**
 * Reclaims upload attempts whose outcome is unknown (docs/plans/video-upload.md 8). The mark comes
 * first, in its own statement, skipping rows a file request holds: after it, that attempt can
 * never be referenced (the file step only takes unmarked rows). Then an unreferenced object is
 * deleted, and the row only once the delete succeeded.
 */
export async function reclaimUploadAttempts(
  now = new Date(),
  storage: VideoStorage = getStorage(),
): Promise<{ deleted: number; failed: number }> {
  const marked = await query<{ key: string }>(
    `update video_upload_attempts set reclaiming = true
     where key in (
       select key from video_upload_attempts
       where created_at < $1::timestamptz - make_interval(hours => $2)
       order by created_at limit 50 for update skip locked
     )
     returning key`,
    [now, ATTEMPT_MAX_AGE_HOURS],
  )
  const result = { deleted: 0, failed: 0 }
  for (const { key } of marked) {
    const used = await query('select 1 from videos where storage_key = $1', [key])
    if (used.length === 0) {
      try {
        await storage.remove(key)
        result.deleted++
      } catch (err) {
        console.warn(`[video-cleanup] attempt ${key} delete failed: ${(err as Error).message}`)
        result.failed++
        continue
      }
    }
    await query('delete from video_upload_attempts where key = $1', [key])
  }
  return result
}
