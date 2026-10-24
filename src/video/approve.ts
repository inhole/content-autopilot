import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { nextFreeSlot } from '../lib/time.ts'
import { currentAccountId } from './accounts.ts'
import { guardSql, type ReviewGuard } from './store.ts'
import { type Platform, toPlatform } from './types.ts'

// Approval (docs/plans/video.md 3-7, 3-8): one transaction locks the video, picks the slot,
// creates a publication per platform and marks it APPROVED. Either all of it happens or none.

const SLOT_RETRIES = 5

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/** The video is not awaiting review or its revision moved on: the caller's view is stale. */
export class VideoNotReviewableError extends Error {
  constructor(videoId: number) {
    super(`video ${videoId} is not awaiting review or has changed`)
    this.name = 'VideoNotReviewableError'
  }
}

/** Earliest free daily video slot for these platforms (a slot is taken if any of them uses it). */
export async function nextVideoSlot(q: Query, platforms: Platform[], now: Date): Promise<Date> {
  const taken = await q<{ scheduled_at: Date }>(
    `select scheduled_at from video_publications
     where platform = any($1::text[]) and scheduled_at >= $2::timestamptz - interval '1 day'`,
    [platforms, now],
  )
  return nextFreeSlot({
    now,
    slots: [config.VIDEO_PUBLISH_SLOT],
    timeZone: config.TZ_NAME,
    taken: taken.map((r) => r.scheduled_at),
    maxDays: 60,
  })
}

export type Approval = { at: Date | null; platforms: Platform[] }

/**
 * Approves the video `guard` points at. Without automatic platforms (VIDEO_PLATFORMS empty) the
 * video is APPROVED with no publications and the owner uploads it by hand.
 */
export async function approveVideo(
  videoId: number,
  guard: ReviewGuard,
  opts: { now?: Date; platforms?: Platform[] } = {},
): Promise<Approval> {
  const now = opts.now ?? new Date()
  const platforms = opts.platforms ?? config.VIDEO_PLATFORMS.map(toPlatform)
  // Resolved before the transaction: account lookups may seed platform_accounts.
  const accounts = new Map<Platform, string>()
  for (const p of platforms) {
    const id = await currentAccountId(p)
    if (!id) throw new Error(`${p === 'REELS' ? 'Instagram' : 'YouTube'} 계정이 설정되지 않았어요`)
    accounts.set(p, id)
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(async (q) => {
        const g = guardSql(guard, 2)
        const [locked] = await q<{ id: number }>(
          `select id from videos
           where id = $1 and status = 'PENDING_REVIEW' and video_url is not null and ${g.sql}
           for update`,
          [videoId, ...g.params],
        )
        if (!locked) throw new VideoNotReviewableError(videoId)
        let at: Date | null = null
        if (platforms.length) {
          at = await nextVideoSlot(q, platforms, now)
          for (const p of platforms) {
            await q(
              `insert into video_publications (video_id, platform, scheduled_at, account_user_id)
               values ($1, $2, $3, $4)`,
              [videoId, p, at, accounts.get(p)],
            )
          }
        }
        await q("update videos set status = 'APPROVED', updated_at = now() where id = $1", [
          videoId,
        ])
        return { at, platforms }
      })
    } catch (err) {
      // A concurrent approval took the slot; read the taken slots again.
      if (!isUniqueViolation(err) || attempt >= SLOT_RETRIES) throw err
    }
  }
}

/**
 * After turning VIDEO_PUBLISH_DRY_RUN off: puts a video's dry-run publications (`dry-` media ids)
 * back to SCHEDULED at the next free slot, bound to the current account. Returns the new time.
 */
export async function resetDryRun(
  videoId: number,
  opts: { now?: Date } = {},
): Promise<Date | null> {
  const now = opts.now ?? new Date()
  const pubs = await query<{ id: number; platform: Platform }>(
    `select id, platform from video_publications
     where video_id = $1 and status = 'PUBLISHED' and platform_media_id like 'dry-%'`,
    [videoId],
  )
  if (pubs.length === 0) return null
  const accounts = new Map<Platform, string | null>()
  for (const p of pubs) accounts.set(p.platform, await currentAccountId(p.platform))
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(async (q) => {
        const at = await nextVideoSlot(
          q,
          pubs.map((p) => p.platform),
          now,
        )
        for (const p of pubs) {
          await q(
            `update video_publications set status = 'SCHEDULED', scheduled_at = $2,
               account_user_id = $3, attempts = 0, container_id = null,
               container_created_at = null, upload_url = null, platform_media_id = null,
               permalink = null, published_at = null, verified_at = null, last_error = null,
               error_kind = null, alerted_at = null, updated_at = now()
             where id = $1 and status = 'PUBLISHED' and platform_media_id like 'dry-%'`,
            [p.id, at, accounts.get(p.platform)],
          )
        }
        await q(
          `update videos set status = 'APPROVED', published_at = null, updated_at = now()
           where id = $1 and status = 'PUBLISHED'`,
          [videoId],
        )
        return at
      })
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= SLOT_RETRIES) throw err
    }
  }
}

/**
 * Moves a publication to the next free slot of its platform and back to SCHEDULED: the retry
 * button on a FAILED row, and overdue SCHEDULED rows after an outage. `from` guards the state the
 * caller saw. Returns the new time, or null when the row was not in that state.
 */
export async function reschedulePublication(
  publicationId: number,
  from: 'FAILED' | 'SCHEDULED',
  opts: { now?: Date; clearUpload?: boolean } = {},
): Promise<Date | null> {
  const now = opts.now ?? new Date()
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(async (q) => {
        const [pub] = await q<{ platform: Platform }>(
          'select platform from video_publications where id = $1 and status = $2 for update',
          [publicationId, from],
        )
        if (!pub) return null
        const at = await nextVideoSlot(q, [pub.platform], now)
        await q(
          `update video_publications set status = 'SCHEDULED', scheduled_at = $2, attempts = 0,
             alerted_at = null, error_kind = null,
             upload_url = case when $3 then null else upload_url end, updated_at = now()
           where id = $1`,
          [publicationId, at, opts.clearUpload ?? false],
        )
        return at
      })
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= SLOT_RETRIES) throw err
    }
  }
}
