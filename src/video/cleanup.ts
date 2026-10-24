import { query } from '../db/pool.ts'
import { getStorage, type VideoStorage } from './storage.ts'

// Deletes stored video files that nothing can need any more (docs/plans/video.md 3-10): videos
// that ended without going out (3 days later) and published ones (14 days later). APPROVED videos
// (scheduled, publishing or failed and retryable) are never touched.

const ENDED_DAYS = 3
const PUBLISHED_DAYS = 14

const DELETABLE = `video_url is not null and storage_key is not null and storage_deleted_at is null
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
    // Re-check right before deleting: a FAILED or EXPIRED video may have been restarted.
    const still = await query(
      `select 1 from videos where id = $4 and storage_key = $5 and ${DELETABLE}`,
      [...params, r.id, r.storage_key],
    )
    if (still.length === 0) continue
    try {
      await storage.remove(r.storage_key)
    } catch (err) {
      console.warn(`[video-cleanup] #${r.id} delete failed: ${(err as Error).message}`)
      result.failed++
      continue
    }
    // Recorded only after the delete succeeded.
    await query(
      `update videos set storage_deleted_at = now(), video_url = null
       where id = $1 and storage_key = $2`,
      [r.id, r.storage_key],
    )
    result.deleted++
  }
  return result
}
