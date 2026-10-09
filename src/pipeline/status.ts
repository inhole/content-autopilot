import { config } from '../config.ts'
import { query } from '../db/pool.ts'

export type Status = {
  pendingReview: { count: number; ids: number[] }
  scheduled: { id: number; scheduledAt: Date; preview: string }[]
  publishedLast24h: number
  failed: { id: number; lastError: string | null }[]
  threads: { dryRun: boolean; tokenExpiresAt: Date | null }
  /** Absent when pg-boss could not be queried or has no run yet. */
  lastDaily?: { state: string; at: Date }
}

const SCHEDULED_SHOWN = 5
const FAILED_SHOWN = 5

export async function loadStatus(now = new Date()): Promise<Status> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000)
  const [pending, scheduled, published, failed, account] = await Promise.all([
    query<{ id: number }>("select id from posts where status = 'PENDING_REVIEW' order by id"),
    query<{ id: number; scheduled_at: Date; text: string }>(
      `select id, scheduled_at, left(text, 30) as text from posts
       where status = 'SCHEDULED' order by scheduled_at limit $1`,
      [SCHEDULED_SHOWN],
    ),
    query<{ n: number }>(
      "select count(*) as n from posts where status = 'PUBLISHED' and published_at >= $1",
      [since],
    ),
    query<{ id: number; last_error: string | null }>(
      "select id, last_error from posts where status = 'FAILED' order by id desc limit $1",
      [FAILED_SHOWN],
    ),
    query<{ expires_at: Date | null }>(
      "select expires_at from platform_accounts where platform = 'THREADS'",
    ),
  ])

  // pg-boss internals may change between versions, so this is best-effort.
  let lastDaily: Status['lastDaily']
  try {
    const [job] = await query<{ state: string; created_on: Date; completed_on: Date | null }>(
      `select state, created_on, completed_on from pgboss.job
       where name = 'daily-pipeline' order by created_on desc limit 1`,
    )
    if (job) lastDaily = { state: job.state, at: job.completed_on ?? job.created_on }
  } catch (err) {
    console.warn('[status] could not read pg-boss job state', err)
  }

  return {
    pendingReview: { count: pending.length, ids: pending.map((p) => p.id) },
    scheduled: scheduled.map((p) => ({
      id: p.id,
      scheduledAt: p.scheduled_at,
      preview: p.text.replace(/\s+/g, ' '),
    })),
    publishedLast24h: published[0]?.n ?? 0,
    failed: failed.map((p) => ({ id: p.id, lastError: p.last_error })),
    threads: { dryRun: config.THREADS_DRY_RUN, tokenExpiresAt: account[0]?.expires_at ?? null },
    lastDaily,
  }
}

function fmt(date: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const g = (t: string) => p.find((x) => x.type === t)?.value
  return `${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Compact plain-text report for Telegram; times are shown in `timeZone`. */
export function formatStatus(status: Status, timeZone: string): string {
  const lines = ['📊 현황']
  lines.push(`Threads: ${status.threads.dryRun ? 'DRY-RUN' : '실제 발행'}`)
  const exp = status.threads.tokenExpiresAt
  lines.push(`토큰 만료: ${exp ? fmt(exp, timeZone) : '정보 없음'}`)
  if (status.lastDaily) {
    lines.push(`마지막 수집: ${fmt(status.lastDaily.at, timeZone)} (${status.lastDaily.state})`)
  }
  const { count, ids } = status.pendingReview
  lines.push(`검수 대기: ${count}건${count ? ` (${ids.map((i) => `#${i}`).join(', ')})` : ''}`)
  lines.push(`최근 24시간 발행: ${status.publishedLast24h}건`)
  if (status.scheduled.length) {
    lines.push('발행 예정:')
    for (const p of status.scheduled) {
      lines.push(`- #${p.id} ${fmt(p.scheduledAt, timeZone)} ${truncate(p.preview, 30)}`)
    }
  } else {
    lines.push('발행 예정: 없음')
  }
  if (status.failed.length) {
    lines.push('실패:')
    for (const p of status.failed) {
      lines.push(`- #${p.id} ${truncate((p.lastError ?? '원인 미상').replace(/\s+/g, ' '), 80)}`)
    }
  }
  return lines.join('\n')
}
