import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { nextFreeSlot } from '../lib/time.ts'
import { currentAccountId, DRY_RUN_ACCOUNT } from './accounts.ts'
import { completeIfAllPublished, guardSql, type ReviewGuard } from './store.ts'
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

// Publications left over from dry-run: "published" with a `dry-` media id, or approved under the
// dry-run account and not published yet (the slot came after the switch, so publishing failed or
// will fail on the account check).
const DRY_LEFTOVER = `((status = 'PUBLISHED' and platform_media_id like 'dry-%')
  or (status in ('SCHEDULED', 'FAILED') and account_user_id = '${DRY_RUN_ACCOUNT}'))`

/**
 * After turning VIDEO_PUBLISH_DRY_RUN off (`video:reset-dry`, the owner's explicit step): puts a
 * video's dry-run publications back to SCHEDULED at the next free slot, bound to the current
 * account. Returns the new time, or null when there was nothing to reset.
 */
export async function resetDryRun(
  videoId: number,
  opts: { now?: Date } = {},
): Promise<Date | null> {
  const now = opts.now ?? new Date()
  const pubs = await query<{ id: number; platform: Platform }>(
    `select id, platform from video_publications where video_id = $1 and ${DRY_LEFTOVER}`,
    [videoId],
  )
  if (pubs.length === 0) return null
  const accounts = new Map<Platform, string>()
  for (const p of pubs) {
    const id = await currentAccountId(p.platform)
    if (!id)
      throw new Error(
        `${p.platform === 'REELS' ? 'Instagram' : 'YouTube'} 계정이 설정되지 않았어요`,
      )
    accounts.set(p.platform, id)
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(async (q) => {
        // Locked so cleanup cannot retire the file meanwhile. Dry-run videos older than the
        // cleanup window have no file left to publish.
        const [video] = await q<{ video_url: string | null }>(
          'select video_url from videos where id = $1 for update',
          [videoId],
        )
        if (!video?.video_url) {
          throw new Error(`영상 #${videoId} 파일이 이미 정리돼서 다시 예약할 수 없어요`)
        }
        const at = await nextVideoSlot(
          q,
          pubs.map((p) => p.platform),
          now,
        )
        let reset = 0
        for (const p of pubs) {
          const rows = await q(
            `update video_publications set status = 'SCHEDULED', scheduled_at = $2,
               account_user_id = $3, attempts = 0, container_id = null,
               container_created_at = null, upload_url = null, platform_media_id = null,
               permalink = null, published_at = null, verified_at = null, last_error = null,
               error_kind = null, alerted_at = null, updated_at = now()
             where id = $1 and ${DRY_LEFTOVER}
             returning id`,
            [p.id, at, accounts.get(p.platform)],
          )
          reset += rows.length
        }
        if (reset === 0) return null
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

/**
 * What the owner saw of a FAILED publication (docs/plans/video-upload.md 4): the failed attempt's
 * claim_seq and, when the outcome is unknown (an expired Shorts session), that they checked the
 * channel. Web and Telegram pass the same guard.
 */
export type FailedGuard = { claimSeq: number; confirmedNotOnChannel?: boolean }

export type FailedDecision<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'stale' | 'confirm'; message: string }

const STALE_FAILURE = '이미 처리됐거나 그 뒤에 다시 시도한 발행이에요.'
const CONFIRM_CHANNEL = '이전 업로드가 끝났는지 몰라요. 채널에 없는 것을 확인한 뒤 눌러 주세요.'

/** Locks the FAILED row the guard points at, or says why not. */
async function lockFailed(
  q: Query,
  publicationId: number,
  guard: FailedGuard,
): Promise<
  | { ok: true; pub: { video_id: number; platform: Platform; error_kind: string | null } }
  | { ok: false; reason: 'stale' | 'confirm'; message: string }
> {
  const [pub] = await q<{ video_id: number; platform: Platform; error_kind: string | null }>(
    `select video_id, platform, error_kind from video_publications
     where id = $1 and status = 'FAILED' and claim_seq = $2 for update`,
    [publicationId, guard.claimSeq],
  )
  if (!pub) return { ok: false, reason: 'stale', message: STALE_FAILURE }
  if (pub.error_kind === 'session' && !guard.confirmedNotOnChannel) {
    return { ok: false, reason: 'confirm', message: CONFIRM_CHANNEL }
  }
  return { ok: true, pub }
}

/**
 * Retries a FAILED publication at the next free slot of its platform. After an unknown outcome
 * the confirmed channel check drops the old upload session, so a new upload starts.
 */
export async function retryFailedPublication(
  publicationId: number,
  guard: FailedGuard,
  opts: { now?: Date } = {},
): Promise<FailedDecision<{ at: Date }>> {
  const now = opts.now ?? new Date()
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(async (q) => {
        const locked = await lockFailed(q, publicationId, guard)
        if (!locked.ok) return locked
        const at = await nextVideoSlot(q, [locked.pub.platform], now)
        await q(
          `update video_publications set status = 'SCHEDULED', scheduled_at = $2, attempts = 0,
             alerted_at = null, error_kind = null,
             upload_url = case when $3 then null else upload_url end, updated_at = now()
           where id = $1`,
          [publicationId, at, locked.pub.error_kind === 'session'],
        )
        return { ok: true as const, at }
      })
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= SLOT_RETRIES) throw err
    }
  }
}

/**
 * Gives up on a FAILED publication (CANCELLED) and finishes the video when nothing else is left:
 * PUBLISHED if another platform went out, FAILED if none did.
 */
export async function cancelPublication(
  publicationId: number,
  guard: FailedGuard,
): Promise<FailedDecision<{ videoId: number; finished: 'PUBLISHED' | 'FAILED' | null }>> {
  return transaction(async (q) => {
    // The video first, then its publications: the same lock order as unapproveVideo.
    const [owner] = await q<{ video_id: number }>(
      'select video_id from video_publications where id = $1',
      [publicationId],
    )
    if (!owner) return { ok: false, reason: 'stale', message: STALE_FAILURE }
    await q('select id from videos where id = $1 for update', [owner.video_id])
    const locked = await lockFailed(q, publicationId, guard)
    if (!locked.ok) return locked
    await q(
      `update video_publications set status = 'CANCELLED', alerted_at = coalesce(alerted_at, now()),
         updated_at = now()
       where id = $1`,
      [publicationId],
    )
    const finished = await completeIfAllPublished(locked.pub.video_id, q)
    return { ok: true as const, videoId: locked.pub.video_id, finished }
  })
}

/**
 * Moves one SCHEDULED publication to just before now, only if its slot is still the one the
 * caller saw (the admin console's `지금 발행`). The publish sweep then claims it as usual.
 */
export async function publishPublicationNow(
  publicationId: number,
  scheduledAt: Date,
): Promise<boolean> {
  const rows = await query(
    `update video_publications set scheduled_at = now() - make_interval(secs => id * 0.001),
       updated_at = now()
     where id = $1 and status = 'SCHEDULED' and scheduled_at = $2 returning id`,
    [publicationId, scheduledAt],
  )
  return rows.length > 0
}
