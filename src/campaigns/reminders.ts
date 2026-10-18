import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import type { CampaignButton } from './tg.ts'
import type { Campaign, CampaignStatus } from './types.ts'

export type Reminder = { kind: string; text: string; buttons: CampaignButton[] }

export type ReminderInput = Pick<
  Campaign,
  'id' | 'status' | 'title' | 'review_deadline' | 'selected_at' | 'received_at'
> &
  Partial<Pick<Campaign, 'keywords' | 'detail'>>

/** Statuses in which the review is still owed. */
export const REVIEW_PENDING_STATUSES: CampaignStatus[] = [
  'SELECTED',
  'RECEIVED',
  'DRAFT_REVIEW',
  'DRAFT_APPROVED',
  'DRAFT_SAVING',
  'DRAFT_SAVED',
  'DRAFT_FAILED',
]
export const RECEIVED_CHECK_AFTER_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole calendar days from `from` to `to` in `tz` (0 = same local day). */
export function calendarDaysBetween(from: Date, to: Date, tz: string): number {
  const a = Date.parse(`${localDate(from, tz)}T00:00:00Z`)
  const b = Date.parse(`${localDate(to, tz)}T00:00:00Z`)
  return Math.round((b - a) / DAY_MS)
}

function formatDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: tz,
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(d)
}

function label(c: ReminderInput): string {
  return c.title?.trim() || `체험단 #${c.id}`
}

function btn(c: ReminderInput, text: string, action: 'received' | 'draft'): CampaignButton {
  return { text, callback: { ns: 'blog', action, campaignId: c.id, revision: 0 } }
}

function deadlineKind(left: number): string | null {
  if (left === 0) return 'review-d0'
  if (left === 1) return 'review-d1'
  if (left >= 2 && left <= 3) return 'review-d3'
  return null
}

/**
 * Pure: the reminders a campaign is due for. Deadline reminders (d3, d1, d0 by calendar day in
 * `tz`) send only the most specific due kind, and nothing once that one has gone out, so a
 * campaign selected one day before its deadline never gets a stale "3 days left".
 */
export function dueReminders(
  c: ReminderInput,
  sent: Set<string>,
  now: Date,
  tz: string,
): Reminder[] {
  const out: Reminder[] = []

  if (c.status === 'SELECTED' && !sent.has('selected')) {
    const lines = ['🎉 체험단에 선정됐어요!', label(c)]
    if (c.review_deadline) lines.push(`리뷰 마감: ${formatDay(c.review_deadline, tz)}`)
    const keywords = c.keywords?.length ? c.keywords : (c.detail?.keywords ?? [])
    if (keywords.length) lines.push(`키워드: ${keywords.join(', ')}`)
    const guide = c.detail?.guide?.trim()
    if (guide) lines.push(`가이드: ${guide.length > 300 ? `${guide.slice(0, 300)}…` : guide}`)
    out.push({
      kind: 'selected',
      text: lines.join('\n'),
      buttons: [btn(c, '📝 초안 쓰기', 'draft')],
    })
  }

  if (
    c.status === 'SELECTED' &&
    c.received_at === null &&
    c.selected_at !== null &&
    now.getTime() >= c.selected_at.getTime() + RECEIVED_CHECK_AFTER_DAYS * DAY_MS &&
    !sent.has('received-check')
  ) {
    out.push({
      kind: 'received-check',
      text: `📦 ${label(c)}\n선정된 지 ${RECEIVED_CHECK_AFTER_DAYS}일이 지났어요. 제품 받으셨나요?`,
      buttons: [btn(c, '📦 받음', 'received'), btn(c, '📝 초안 쓰기', 'draft')],
    })
  }

  if (c.review_deadline && REVIEW_PENDING_STATUSES.includes(c.status)) {
    const left = calendarDaysBetween(now, c.review_deadline, tz)
    const kind = deadlineKind(left)
    if (kind && !sent.has(kind)) {
      const when = left === 0 ? '오늘' : left === 1 ? '내일' : `${left}일 뒤`
      out.push({
        kind,
        text: `⏰ ${label(c)}\n리뷰 마감이 ${when}(${formatDay(c.review_deadline, tz)})이에요.`,
        buttons:
          c.status === 'SELECTED' || c.status === 'RECEIVED'
            ? [btn(c, '📝 초안 쓰기', 'draft')]
            : [],
      })
    }
  }
  return out
}

/**
 * Sends every due reminder once. The campaign_reminders row is inserted first (on conflict do
 * nothing), so two overlapping runs cannot both send; if the send throws the row is deleted so
 * the next run retries, and the other reminders carry on. Returns how many were sent.
 */
export async function runCampaignReminders(
  send: (text: string, buttons: CampaignButton[]) => Promise<unknown>,
  now = new Date(),
  tz: string = config.TZ_NAME,
): Promise<number> {
  const campaigns = await query<ReminderInput>(
    `select id, status, title, review_deadline, selected_at, received_at, keywords, detail
     from campaigns where status = any($1::text[]) order by id`,
    [REVIEW_PENDING_STATUSES],
  )
  let sentCount = 0
  for (const c of campaigns) {
    const rows = await query<{ kind: string }>(
      'select kind from campaign_reminders where campaign_id = $1',
      [c.id],
    )
    const already = new Set(rows.map((r) => r.kind))
    for (const reminder of dueReminders(c, already, now, tz)) {
      const inserted = await query<{ kind: string }>(
        `insert into campaign_reminders (campaign_id, kind, sent_at) values ($1, $2, $3)
         on conflict do nothing returning kind`,
        [c.id, reminder.kind, now],
      )
      if (inserted.length === 0) continue
      try {
        await send(reminder.text, reminder.buttons)
        sentCount++
      } catch (err) {
        console.error(`campaign ${c.id} reminder ${reminder.kind} failed:`, err)
        await query('delete from campaign_reminders where campaign_id = $1 and kind = $2', [
          c.id,
          reminder.kind,
        ])
      }
    }
  }
  return sentCount
}
