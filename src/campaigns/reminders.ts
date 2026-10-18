import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import type { CampaignButton } from './tg.ts'
import type { Campaign } from './types.ts'

export type Reminder = { kind: string; text: string; buttons: CampaignButton[] }

export type ReminderInput = Pick<
  Campaign,
  'id' | 'status' | 'title' | 'apply_deadline' | 'selected_at' | 'review_deadline'
>

const DAY_MS = 24 * 60 * 60 * 1000
const REMINDER_STATUSES = ['APPLIED', 'SELECTED', 'DRAFT_REVIEW']

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
  return `#${c.id} ${c.title?.trim() || '체험단'}`
}

const resultButtons = (c: ReminderInput): CampaignButton[] => [
  { text: '🎉 선정', callback: { ns: 'camp', action: 'sel', campaignId: c.id, revision: 0 } },
  { text: '😢 미선정', callback: { ns: 'camp', action: 'unsel', campaignId: c.id, revision: 0 } },
]

const draftButton = (c: ReminderInput): CampaignButton => ({
  text: '📝 리뷰 초안 쓰기',
  callback: { ns: 'rev', action: 'draft', campaignId: c.id, revision: 0 },
})

/** Deadline reminder kinds from least to most specific. */
const DEADLINE_KINDS = ['review-d3', 'review-d1', 'review-d0'] as const

function deadlineKind(left: number): (typeof DEADLINE_KINDS)[number] | null {
  if (left <= 0) return 'review-d0'
  if (left === 1) return 'review-d1'
  if (left <= 3) return 'review-d3'
  return null
}

/**
 * Pure: the reminders a campaign is due for. Deadline reminders (d3, d1, d0 by calendar day in
 * `tz`) send only the most specific due kind, and nothing once that or a more specific one has
 * gone out, so a campaign selected one day before its deadline never gets a stale "3 days left".
 */
export function dueReminders(
  c: ReminderInput,
  sent: Set<string>,
  now: Date,
  tz: string,
): Reminder[] {
  const out: Reminder[] = []

  if (
    c.status === 'APPLIED' &&
    c.apply_deadline &&
    now.getTime() >= c.apply_deadline.getTime() + DAY_MS &&
    !sent.has('result-check')
  ) {
    out.push({
      kind: 'result-check',
      text: `📮 ${label(c)}\n신청 마감이 지났어요. 결과가 나왔나요? 카카오톡에서 확인하고 눌러주세요.`,
      buttons: resultButtons(c),
    })
  }

  if (
    c.status === 'SELECTED' &&
    c.review_deadline === null &&
    c.selected_at !== null &&
    now.getTime() >= c.selected_at.getTime() + DAY_MS &&
    !sent.has('due-missing')
  ) {
    out.push({
      kind: 'due-missing',
      text: `⏳ ${label(c)}\n리뷰 기한을 아직 몰라요. /due ${c.id} 10/30 처럼 알려주세요.`,
      buttons: [],
    })
  }

  if (c.review_deadline && (c.status === 'SELECTED' || c.status === 'DRAFT_REVIEW')) {
    const left = calendarDaysBetween(now, c.review_deadline, tz)
    const kind = deadlineKind(left)
    if (kind) {
      const moreSpecific = DEADLINE_KINDS.slice(DEADLINE_KINDS.indexOf(kind))
      if (!moreSpecific.some((k) => sent.has(k))) {
        const when = left <= 0 ? '오늘' : left === 1 ? '내일' : `${left}일 뒤`
        out.push({
          kind,
          text: `⏰ ${label(c)}\n리뷰 마감이 ${when}(${formatDay(c.review_deadline, tz)})이에요.`,
          buttons: c.status === 'SELECTED' ? [draftButton(c)] : [],
        })
      }
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
    `select id, status, title, apply_deadline, selected_at, review_deadline
     from campaigns where status = any($1::text[]) order by id`,
    [REMINDER_STATUSES],
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
