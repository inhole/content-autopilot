import { query } from '../db/pool.ts'
import { localDate, localHour } from '../lib/time.ts'

/** A draft untouched this long is dropped: the news behind it is stale. */
export const DRAFT_TTL_HOURS = 48
/** A draft is warned once its remaining life drops to this many hours. */
export const EXPIRY_WARNING_HOURS = 24
/** Local hours at which a pending-review reminder is sent. */
export const REMINDER_HOURS = [9, 18]

type PendingDraft = { id: number; lastTouchedAt: Date }
type WarnableDraft = PendingDraft & { warnedAt: Date | null }
export type ExpiringDraft = { id: number; expiresAt: Date }

/**
 * Which pending drafts have gone stale. Age is measured from the last touch (updated_at), not
 * from creation: regenerating, editing or un-scheduling a draft is a review action, and an
 * approved post taken back days later must get a fresh window instead of expiring at once.
 */
export function selectExpired(drafts: PendingDraft[], now: Date): number[] {
  const cutoff = now.getTime() - DRAFT_TTL_HOURS * 3600_000
  return drafts.filter((d) => d.lastTouchedAt.getTime() < cutoff).map((d) => d.id)
}

/**
 * Drafts with 24h or less (and more than 0) left before they expire, not yet warned for this
 * touch. A warning older than the last touch no longer counts: the touch restarted the clock.
 */
export function selectExpiringSoon(drafts: WarnableDraft[], now: Date): ExpiringDraft[] {
  const ttl = DRAFT_TTL_HOURS * 3600_000
  return drafts
    .filter((d) => {
      const left = d.lastTouchedAt.getTime() + ttl - now.getTime()
      const warned = d.warnedAt !== null && d.warnedAt.getTime() >= d.lastTouchedAt.getTime()
      return left > 0 && left <= EXPIRY_WARNING_HOURS * 3600_000 && !warned
    })
    .map((d) => ({ id: d.id, expiresAt: new Date(d.lastTouchedAt.getTime() + ttl) }))
}

/** The hourly job runs at minute 0, so a reminder is due when the local hour is a reminder hour. */
export function shouldRemind(now: Date, timeZone: string, pendingCount: number): boolean {
  return pendingCount > 0 && REMINDER_HOURS.includes(localHour(now, timeZone))
}

const ids = (list: number[]) => list.map((i) => `#${i}`).join(', ')

export const formatExpired = (expired: number[]) =>
  `⌛ 오래된 초안 ${expired.length}건 만료: ${ids(expired)}`

export const formatReminder = (pending: number[]) =>
  `📝 검수 대기 ${pending.length}건: ${ids(pending)}`

/** `#12 (오늘 21시까지)`: the day is relative to `now` in the local zone. */
export function formatExpiryWarning(
  expiring: ExpiringDraft[],
  now: Date,
  timeZone: string,
): string {
  const today = localDate(now, timeZone)
  const items = expiring.map((d) => {
    const day = localDate(d.expiresAt, timeZone) === today ? '오늘' : '내일'
    const hour = String(localHour(d.expiresAt, timeZone)).padStart(2, '0')
    return `#${d.id} (${day} ${hour}시까지)`
  })
  return [
    `⏳ 내일 만료되는 초안 ${expiring.length}건: ${items.join(', ')}`,
    '검수 메시지에서 승인하거나, 답장으로 고치면 만료가 48시간 늦춰져요',
  ].join('\n')
}

export type MaintenanceResult = {
  expired: number[]
  remindedPending: number[]
  warned: number[]
}

/** Dependencies are injected so the orchestration can be tested without a database. */
export async function runReviewMaintenance(
  deps: {
    loadPending: () => Promise<PendingDraft[]>
    expire: (ids: number[]) => Promise<number[]>
    retire: (ids: number[]) => Promise<void>
    loadExpiring: () => Promise<WarnableDraft[]>
    markWarned: (ids: number[]) => Promise<void>
    notify: (text: string) => Promise<void>
  },
  now: Date,
  timeZone: string,
): Promise<MaintenanceResult> {
  const pending = await deps.loadPending()
  const toExpire = selectExpired(pending, now)
  // Re-checked in SQL, so a draft approved meanwhile is not expired.
  const expired = toExpire.length ? await deps.expire(toExpire) : []
  if (expired.length) {
    await deps.retire(expired).catch((err) => console.warn('[maintenance] retire failed', err))
    await deps.notify(formatExpired(expired))
  }
  const expiredSet = new Set(expired)
  const remaining = pending.map((p) => p.id).filter((id) => !expiredSet.has(id))
  let remindedPending: number[] = []
  if (shouldRemind(now, timeZone, remaining.length)) {
    await deps.notify(formatReminder(remaining))
    remindedPending = remaining
  }
  // Drafts that expired in this run are gone; a warning for them would be noise.
  const expiring = selectExpiringSoon(await deps.loadExpiring(), now).filter(
    (d) => !expiredSet.has(d.id),
  )
  let warned: number[] = []
  if (expiring.length) {
    await deps.notify(formatExpiryWarning(expiring, now, timeZone))
    // Only after the send: a failed send is retried by the next hourly run.
    await deps.markWarned(expiring.map((d) => d.id))
    warned = expiring.map((d) => d.id)
  }
  return { expired, remindedPending, warned }
}

/**
 * Pending drafts that may need the warning: within the last 24h of their life and not warned
 * since their last touch (selectExpiringSoon re-checks both in code).
 */
export async function loadExpiringDrafts(now: Date): Promise<WarnableDraft[]> {
  const rows = await query<{ id: number; updated_at: Date; expiry_warned_at: Date | null }>(
    `select id, updated_at, expiry_warned_at from posts
     where status = 'PENDING_REVIEW'
       and (expiry_warned_at is null or expiry_warned_at < updated_at)
       and updated_at <= $1::timestamptz - make_interval(hours => $2)
     order by id`,
    [now, DRAFT_TTL_HOURS - EXPIRY_WARNING_HOURS],
  )
  return rows.map((r) => ({ id: r.id, lastTouchedAt: r.updated_at, warnedAt: r.expiry_warned_at }))
}

/**
 * Records the warning without touching updated_at (that would extend the draft's life). The
 * stamp is the run's `now`, so a touch after the load still sorts later and warns again.
 */
export async function markExpiryWarned(draftIds: number[], now: Date): Promise<void> {
  await query(
    "update posts set expiry_warned_at = $2 where id = any($1::bigint[]) and status = 'PENDING_REVIEW'",
    [draftIds, now],
  )
}

export const loadPendingDrafts = async (): Promise<PendingDraft[]> =>
  (
    await query<{ id: number; updated_at: Date }>(
      "select id, updated_at from posts where status = 'PENDING_REVIEW' order by id",
    )
  ).map((r) => ({ id: r.id, lastTouchedAt: r.updated_at }))

/** A draft this long without a review message lost its review job; the hourly sweep resends it. */
export const UNSENT_REVIEW_MINUTES = 10

/**
 * PENDING_REVIEW drafts that never got a review message. Every path that creates or revives a
 * draft commits the row first and enqueues `review` afterwards (generate, revive, digest), so a
 * crash or a failed enqueue in between would otherwise leave a draft nobody is told about; a
 * retry of those jobs cannot redo it, since the row already moved on.
 */
export async function loadUnsentReviews(now: Date): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from posts
     where status = 'PENDING_REVIEW' and review_message_id is null
       and updated_at < $1::timestamptz - make_interval(mins => $2)
     order by id`,
    [now, UNSENT_REVIEW_MINUTES],
  )
  return rows.map((r) => r.id)
}

/** Conditioned on the status and age again so a draft touched since the load is left alone. */
export async function expireDrafts(draftIds: number[], now: Date): Promise<number[]> {
  const cutoff = new Date(now.getTime() - DRAFT_TTL_HOURS * 3600_000)
  const rows = await query<{ id: number }>(
    `update posts set status = 'EXPIRED', updated_at = now()
     where id = any($1::bigint[]) and status = 'PENDING_REVIEW' and updated_at < $2
     returning id`,
    [draftIds, cutoff],
  )
  return rows.map((r) => r.id).sort((a, b) => a - b)
}
