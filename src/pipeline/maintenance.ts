import { query } from '../db/pool.ts'
import { localHour } from '../lib/time.ts'

/** A draft untouched this long is dropped: the news behind it is stale. */
export const DRAFT_TTL_HOURS = 48
/** Local hours at which a pending-review reminder is sent. */
export const REMINDER_HOURS = [9, 18]

type PendingDraft = { id: number; lastTouchedAt: Date }

/**
 * Which pending drafts have gone stale. Age is measured from the last touch (updated_at), not
 * from creation: regenerating, editing or un-scheduling a draft is a review action, and an
 * approved post taken back days later must get a fresh window instead of expiring at once.
 */
export function selectExpired(drafts: PendingDraft[], now: Date): number[] {
  const cutoff = now.getTime() - DRAFT_TTL_HOURS * 3600_000
  return drafts.filter((d) => d.lastTouchedAt.getTime() < cutoff).map((d) => d.id)
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

export type MaintenanceResult = { expired: number[]; remindedPending: number[] }

/** Dependencies are injected so the orchestration can be tested without a database. */
export async function runReviewMaintenance(
  deps: {
    loadPending: () => Promise<PendingDraft[]>
    expire: (ids: number[]) => Promise<number[]>
    retire: (ids: number[]) => Promise<void>
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
  return { expired, remindedPending }
}

export const loadPendingDrafts = async (): Promise<PendingDraft[]> =>
  (
    await query<{ id: number; updated_at: Date }>(
      "select id, updated_at from posts where status = 'PENDING_REVIEW' order by id",
    )
  ).map((r) => ({ id: r.id, lastTouchedAt: r.updated_at }))

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
