import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { currentAccountId, getInstagramApi, getYouTubeApi } from './accounts.ts'
import { findPublishedReel, type InstagramApi, InstagramApiError } from './instagram.ts'
import { getStorage, type VideoStorage } from './storage.ts'
import { completeIfAllPublished, fullCaption, loadVideo, type VideoRow } from './store.ts'
import { type Platform, youtubeSafe, youtubeTitle } from './types.ts'
import {
  publicationTag,
  type UploadState,
  type YouTubeApi,
  YouTubeApiError,
  YouTubeAuthError,
} from './youtube.ts'

// Publishing one video_publications row (docs/plans/video.md 3-9). Same claim model as posts: the
// claim bumps claim_seq, every later write is conditioned on it, and the external id (container or
// upload session) is saved before the irreversible step so a retry resumes instead of re-posting.

export const MAX_ATTEMPTS = 3
/** Extra attempts while we cannot tell whether the last one went out. */
const MAX_UNKNOWN_ATTEMPTS = MAX_ATTEMPTS * 2
/** Longer than the longest single external call (5 min upload) plus the Reels wait (8 min). */
export const STALE_PUBLISHING_MINUTES = 15
/** SCHEDULED rows this far past their slot are moved to the next slot instead of going out late. */
export const OVERDUE_HOURS = 6
const REELS_POLL_MS = 10_000
const REELS_MAX_WAIT_MS = 8 * 60_000
const REELS_CONTAINER_MAX_AGE_MS = 2 * 60 * 60_000

export type ErrorKind = 'auth' | 'account' | 'session' | 'other'

/** A failure that retrying cannot fix; the row goes straight to FAILED with this kind. */
export class FinalPublishError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
  ) {
    super(message)
    this.name = 'FinalPublishError'
  }
}

/** Another worker took over this publication's claim. */
export class LostClaimError extends Error {
  constructor() {
    super('publication claim was taken over by another worker')
    this.name = 'LostClaimError'
  }
}

/** Reels is still processing the video: not a failure, try again on the next sweep. */
class StillProcessingError extends Error {}

export type PublicationOutcome =
  | { kind: 'published'; platform: Platform; mediaId: string | null; permalink: string | null }
  | { kind: 'processing' }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string; errorKind: ErrorKind }
  | { kind: 'skipped' }

type PubRow = {
  id: number
  video_id: number
  platform: Platform
  attempts: number
  claim_seq: number
  container_id: string | null
  container_created_at: Date | null
  upload_url: string | null
  account_user_id: string | null
  scheduled_at: Date
}

/** Due rows, stale PUBLISHING rows to resume, and SCHEDULED rows too late to go out now. */
export async function duePublications(
  now = new Date(),
): Promise<{ due: number[]; overdue: number[] }> {
  const rows = await query<{ id: number; overdue: boolean }>(
    `select id, (status = 'SCHEDULED'
                 and scheduled_at <= $1::timestamptz - make_interval(hours => $3)) as overdue
     from video_publications
     where (status = 'SCHEDULED' and scheduled_at <= $1)
        or (status = 'PUBLISHING' and updated_at < $1::timestamptz - make_interval(mins => $2))
     order by scheduled_at, id`,
    [now, STALE_PUBLISHING_MINUTES, OVERDUE_HOURS],
  )
  return {
    due: rows.filter((r) => !r.overdue).map((r) => r.id),
    overdue: rows.filter((r) => r.overdue).map((r) => r.id),
  }
}

/** Classifies an error from a platform call: auth problems are final, everything else retries. */
export function classify(err: unknown): FinalPublishError | null {
  if (err instanceof FinalPublishError) return err
  if (err instanceof YouTubeAuthError) return new FinalPublishError(err.message, 'auth')
  if ((err instanceof InstagramApiError || err instanceof YouTubeApiError) && err.isAuth) {
    return new FinalPublishError(`토큰이 거절됐어요: ${err.message}`, 'auth')
  }
  return null
}

export type FailureDecision = 'published' | 'retry' | 'failed'

/** Same rule as posts: a PUBLISHED container wins; unknown outcomes get a few extra attempts. */
export function decideAfterFailure(input: {
  attempts: number
  containerStatus: string | null
}): FailureDecision {
  if (input.containerStatus === 'PUBLISHED') return 'published'
  if (input.attempts < MAX_ATTEMPTS) return 'retry'
  if (input.containerStatus === 'unknown' && input.attempts < MAX_UNKNOWN_ATTEMPTS) return 'retry'
  return 'failed'
}

type Sleep = (ms: number) => Promise<void>
const sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

type Owned = (set: string, params?: unknown[]) => Promise<boolean>

type Deps = {
  instagram?: InstagramApi
  youtube?: YouTubeApi
  storage?: VideoStorage
  sleep?: Sleep
  /** Clock for the Reels wait and container age (tests). */
  clock?: () => number
}

type Result = { mediaId: string | null; permalink: string | null }

export async function publishPublication(
  publicationId: number,
  deps: Deps = {},
): Promise<PublicationOutcome> {
  // The schedule is checked here, not trusted from the enqueue: a SCHEDULED row is taken only when
  // due and not overdue, so a job queued before an outage or a reschedule does not publish early
  // or hours late (the overdue sweep moves it to the next slot instead).
  const [row] = await query<PubRow>(
    `update video_publications set status = 'PUBLISHING', attempts = attempts + 1,
       claim_seq = claim_seq + 1, updated_at = now()
     where id = $1
       and ((status = 'SCHEDULED' and scheduled_at <= now()
             and scheduled_at > now() - make_interval(hours => $3))
            or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $2)))
     returning id, video_id, platform, attempts, claim_seq, container_id, container_created_at,
       upload_url, account_user_id, scheduled_at`,
    [publicationId, STALE_PUBLISHING_MINUTES, OVERDUE_HOURS],
  )
  if (!row) return { kind: 'skipped' }
  const token = row.claim_seq
  const owned: Owned = async (set, params = []) => {
    const rows = await query(
      `update video_publications set ${set}, updated_at = now()
       where id = $1 and status = 'PUBLISHING' and claim_seq = $2 returning id`,
      [publicationId, token, ...params],
    )
    return rows.length > 0
  }
  const heartbeat = async () => {
    if (!(await owned('status = status'))) throw new LostClaimError()
  }

  let instagram = deps.instagram
  let containerId = row.container_id
  // A Reel published by this claim cannot be older than its container or, for a container made
  // now, than this attempt. The slot is no bound: publish-now sends posts before their slot.
  const reelSince = new Date((row.container_created_at ?? new Date()).getTime() - 60_000)
  try {
    const video = await loadVideo(row.video_id)
    if (!video?.video_url) throw new FinalPublishError('영상 파일이 없어요', 'other')
    const account = await currentAccountId(row.platform)
    if (account !== row.account_user_id) {
      throw new FinalPublishError(
        `승인할 때 계정(${row.account_user_id ?? '-'})과 지금 계정(${account ?? '없음'})이 달라요`,
        'account',
      )
    }
    let result: Result
    if (row.platform === 'REELS') {
      instagram ??= await getInstagramApi()
      result = await driveReel(instagram, row, video, owned, heartbeat, deps, reelSince, (id) => {
        containerId = id
      })
    } else {
      const youtube = deps.youtube ?? (await getYouTubeApi())
      const storage = deps.storage ?? getStorage()
      result = await driveShort(youtube, storage, row, video, owned, heartbeat)
    }
    const saved = await owned(
      `status = 'PUBLISHED', platform_media_id = $3, permalink = $4, published_at = now(),
       last_error = null, error_kind = null`,
      [result.mediaId, result.permalink],
    )
    if (!saved) return { kind: 'skipped' }
    await completeIfAllPublished(row.video_id)
    return { kind: 'published', platform: row.platform, ...result }
  } catch (err) {
    if (err instanceof LostClaimError) return { kind: 'skipped' }
    if (err instanceof StillProcessingError) {
      // Waiting on Instagram is not an attempt.
      const saved = await owned("status = 'SCHEDULED', attempts = attempts - 1, last_error = $3", [
        'Reels 처리 중',
      ])
      return saved ? { kind: 'processing' } : { kind: 'skipped' }
    }
    const error = (err as Error).message.slice(0, 1000)
    const final = classify(err)
    if (final) {
      const saved = await owned("status = 'FAILED', last_error = $3, error_kind = $4", [
        error,
        final.kind,
      ])
      return saved ? { kind: 'failed', error, errorKind: final.kind } : { kind: 'skipped' }
    }
    // The publish response may have been lost after Instagram published: ask the container.
    let containerStatus: string | null = null
    if (row.platform === 'REELS' && containerId) {
      try {
        instagram ??= await getInstagramApi()
        containerStatus = (await instagram.getContainerStatus(containerId)).status
      } catch {
        containerStatus = 'unknown'
      }
    }
    const decision = decideAfterFailure({ attempts: row.attempts, containerStatus })
    if (decision === 'published' && instagram) {
      const video = await loadVideo(row.video_id)
      const mediaId = video ? await recoverReelId(instagram, fullCaption(video), reelSince) : null
      const saved = await owned(
        `status = 'PUBLISHED', platform_media_id = $3, published_at = now(), last_error = null,
         error_kind = null`,
        [mediaId],
      )
      if (!saved) return { kind: 'skipped' }
      await completeIfAllPublished(row.video_id)
      return { kind: 'published', platform: row.platform, mediaId, permalink: null }
    }
    const failed = decision === 'failed'
    const saved = await owned(
      `status = '${failed ? 'FAILED' : 'SCHEDULED'}', last_error = $3, error_kind = $4`,
      [error, failed ? 'other' : null],
    )
    if (!saved) return { kind: 'skipped' }
    return failed ? { kind: 'failed', error, errorKind: 'other' } : { kind: 'retry', error }
  }
}

/** Media id of a Reel whose publish response was lost; null unless exactly one match. */
async function recoverReelId(
  api: InstagramApi,
  caption: string,
  since: Date,
): Promise<string | null> {
  try {
    return findPublishedReel(await api.listRecentMedia(), caption, since)
  } catch (err) {
    console.warn('[video-publish] media id lookup failed', (err as Error).message)
    return null
  }
}

async function driveReel(
  api: InstagramApi,
  row: PubRow,
  video: VideoRow,
  owned: Owned,
  heartbeat: () => Promise<void>,
  deps: Deps,
  since: Date,
  onContainer: (id: string) => void,
): Promise<Result> {
  const wait = deps.sleep ?? sleep
  const now = deps.clock ?? Date.now
  const caption = fullCaption(video)
  const published = async (): Promise<Result> => ({
    mediaId: await recoverReelId(api, caption, since),
    permalink: null,
  })

  let id = row.container_id
  let createdAt = row.container_created_at?.getTime() ?? now()
  if (id) {
    const { status } = await api.getContainerStatus(id)
    if (status === 'PUBLISHED') return published()
    if (status === 'ERROR' || status === 'EXPIRED') id = null
    else if (status === 'IN_PROGRESS' && now() - createdAt > REELS_CONTAINER_MAX_AGE_MS) {
      // Never finished; drop it so the next attempt makes a fresh container.
      if (!(await owned('container_id = null, container_created_at = null'))) {
        throw new LostClaimError()
      }
      throw new Error(`container ${id} still IN_PROGRESS after 2h`)
    }
  }
  if (!id) {
    if (!video.video_url?.startsWith('https://')) {
      throw new FinalPublishError(
        'Reels는 공개 https 영상 주소가 필요해요 (VIDEO_STORAGE=supabase)',
        'other',
      )
    }
    id = await api.createReelContainer({ videoUrl: video.video_url, caption })
    onContainer(id)
    createdAt = now()
    if (!(await owned('container_id = $3, container_created_at = now()', [id]))) {
      throw new LostClaimError()
    }
  }
  onContainer(id)

  const deadline = now() + REELS_MAX_WAIT_MS
  for (;;) {
    const { status, error } = await api.getContainerStatus(id)
    if (status === 'FINISHED') break
    if (status === 'PUBLISHED') return published()
    if (status === 'ERROR' || status === 'EXPIRED') {
      if (!(await owned('container_id = null, container_created_at = null'))) {
        throw new LostClaimError()
      }
      throw new Error(`container ${id} ${status}: ${error ?? 'no detail'}`)
    }
    if (now() >= deadline) throw new StillProcessingError()
    await heartbeat()
    await wait(REELS_POLL_MS)
  }

  await heartbeat()
  let mediaId: string
  try {
    mediaId = await api.publish(id)
  } catch (err) {
    // The response may be lost after the post went out.
    const recheck = await api.getContainerStatus(id).catch(() => null)
    if (recheck?.status === 'PUBLISHED') return published()
    throw err
  }
  const permalink = await api.permalink(mediaId).catch(() => null)
  return { mediaId, permalink }
}

export const shortsUrl = (videoId: string) => `https://youtube.com/shorts/${videoId}`

async function driveShort(
  api: YouTubeApi,
  storage: VideoStorage,
  row: PubRow,
  video: VideoRow,
  owned: Owned,
  heartbeat: () => Promise<void>,
): Promise<Result> {
  if (!video.video_url) throw new FinalPublishError('영상 파일이 없어요', 'other')
  const bytes = await storage.download(video.video_url)
  const done = (state: UploadState): Result | null =>
    state.kind === 'complete'
      ? { mediaId: state.videoId, permalink: shortsUrl(state.videoId) }
      : null

  let session = row.upload_url
  let from = 0
  if (session) {
    const state = await api.uploadStatus(session, bytes.length)
    const complete = done(state)
    if (complete) return complete
    if (state.kind === 'gone') {
      // An expired session does not tell whether the earlier upload finished: look for our tag,
      // and never start a second upload on our own.
      const found = await api.findUploadByTag(publicationTag(row.id))
      if (found) return { mediaId: found, permalink: shortsUrl(found) }
      throw new FinalPublishError(
        '업로드 세션이 만료됐어요. 채널에 영상이 올라갔는지 확인하고, 없으면 다시 시도를 눌러주세요',
        'session',
      )
    }
    if (state.kind === 'incomplete') from = state.received
  } else {
    session = await api.startUpload({
      title: youtubeTitle(video.title ?? ''),
      description: youtubeSafe(fullCaption(video)),
      tags: [...video.hashtags.map(youtubeSafe), publicationTag(row.id)],
      privacy: config.YOUTUBE_PRIVACY,
      sizeBytes: bytes.length,
    })
    if (!(await owned('upload_url = $3', [session]))) throw new LostClaimError()
  }
  await heartbeat()
  const state = await api.upload(session, bytes, from)
  const complete = done(state)
  if (complete) return complete
  throw new Error(
    state.kind === 'gone' ? 'upload session vanished during the upload' : 'upload incomplete',
  )
}

// Sweeps run by video-publish-due

/** Uploaded Shorts whose processing result has not been checked yet (first 24h). */
export async function unverifiedShorts(): Promise<
  { id: number; video_id: number; platform_media_id: string; published_at: Date }[]
> {
  return query(
    `select id, video_id, platform_media_id, published_at from video_publications
     where platform = 'SHORTS' and status = 'PUBLISHED' and verified_at is null
       and platform_media_id is not null and platform_media_id not like 'dry-%'
     order by id`,
  )
}

export type Verification = { done: boolean; problem: string | null }

/** What a processing check means. `expectedPrivacy` is what the upload asked for. */
export function judgeShortStatus(
  s: {
    uploadStatus: string
    privacyStatus: string | null
    failureReason: string | null
    rejectionReason: string | null
  } | null,
  expectedPrivacy: string,
  ageMs: number,
): Verification {
  const tooOld = ageMs > 24 * 60 * 60_000
  if (!s)
    return tooOld
      ? { done: true, problem: '영상을 찾을 수 없어요' }
      : { done: false, problem: null }
  if (s.uploadStatus === 'processed') {
    if (s.privacyStatus && s.privacyStatus !== expectedPrivacy) {
      return {
        done: true,
        problem: `공개 범위가 ${s.privacyStatus}예요 (기대: ${expectedPrivacy})`,
      }
    }
    return { done: true, problem: null }
  }
  if (['failed', 'rejected', 'deleted'].includes(s.uploadStatus)) {
    const reason = s.failureReason ?? s.rejectionReason ?? s.uploadStatus
    return { done: true, problem: `YouTube 처리 실패: ${reason}` }
  }
  return tooOld
    ? { done: true, problem: `24시간이 지나도 처리 중이에요 (${s.uploadStatus})` }
    : { done: false, problem: null }
}

export async function markVerified(publicationId: number, problem: string | null): Promise<void> {
  await query(
    `update video_publications set verified_at = now(),
       last_error = coalesce($2, last_error), updated_at = now()
     where id = $1`,
    [publicationId, problem],
  )
}

/** FAILED publications whose alert has not gone out yet. */
export async function unalertedFailures(): Promise<
  {
    id: number
    video_id: number
    platform: Platform
    last_error: string | null
    error_kind: string | null
  }[]
> {
  return query(
    `select id, video_id, platform, last_error, error_kind from video_publications
     where status = 'FAILED' and alerted_at is null order by id`,
  )
}

export async function markAlerted(publicationId: number): Promise<void> {
  await query('update video_publications set alerted_at = now() where id = $1', [publicationId])
}

/** Moves a publication's slot to now so the next sweep sends it (CLI `video:publish-now`). */
export async function publishVideoNow(videoId: number): Promise<number> {
  // Just before now (claims only take due rows), offset per row for the unique slot index.
  const rows = await query(
    `update video_publications set scheduled_at = now() - make_interval(secs => id * 0.001),
       updated_at = now()
     where video_id = $1 and status = 'SCHEDULED' returning id`,
    [videoId],
  )
  return rows.length
}

export const isDryRunMediaId = (id: string | null) => id?.startsWith('dry-') ?? false
