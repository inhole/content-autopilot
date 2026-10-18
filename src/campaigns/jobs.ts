import type { Bot } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { config } from '../config.ts'
import { formatFinalFailure, isFinalAttempt } from '../jobs.ts'
import { localHour } from '../lib/time.ts'
import { collectGiftCampaigns } from './collect.ts'
import { rankCollected } from './rank.ts'
import { runCampaignReminders } from './reminders.ts'
import { expireCampaigns } from './review.ts'
import { generateReviewDraft, requestDraftRegeneration } from './review-draft.ts'
import { registerReviewBot, sendDraft } from './review-telegram.ts'
import { registerCampaignBot, sendCampaignCard } from './telegram.ts'
import { clearButtons, sendCampaignMessage } from './tg.ts'

export const CQ = {
  collect: 'gift-collect',
  card: 'campaign-card',
  reviewDraft: 'review-draft',
  maintenance: 'campaign-maintenance',
} as const

// Same idea as the retry limits in src/jobs.ts: shared by createQueue and the final-failure check.
const COLLECT_RETRY_LIMIT = 1
const CARD_RETRY_LIMIT = 3
const REVIEW_DRAFT_RETRY_LIMIT = 2

/** Reminders go out between these local hours (inclusive) so nothing pings at night. */
export const REMINDER_FIRST_HOUR = 9
export const REMINDER_LAST_HOUR = 21

type CampaignData = { campaignId: number }
type ReviewDraftData = { campaignId: number; feedback?: string; seq?: number }

export function isReminderHour(now: Date, tz: string): boolean {
  const hour = localHour(now, tz)
  return hour >= REMINDER_FIRST_HOUR && hour <= REMINDER_LAST_HOUR
}

/** Runs `fn` and, if it throws on the queue's last attempt, tells the owner before rethrowing. */
async function alertOnFinalFailure<T>(
  job: { retryCount: number },
  retryLimit: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isFinalAttempt(job.retryCount, retryLimit)) {
      try {
        await sendCampaignMessage(formatFinalFailure(label, err))
      } catch (notifyErr) {
        console.error(`[${label}] failed to send failure alert`, notifyErr)
      }
    }
    throw err
  }
}

const sendCard = (boss: PgBoss, campaignId: number) =>
  boss.send(CQ.card, { campaignId } satisfies CampaignData, {
    singletonKey: `campaign-${campaignId}`,
  })

/**
 * Queues a review draft. The seq is bumped here, at request time, so an older queued request can
 * never overwrite the draft of a newer one (same model as enqueueRegeneration in src/jobs.ts).
 */
export async function enqueueReviewDraft(
  boss: PgBoss,
  campaignId: number,
  feedback?: string,
): Promise<boolean> {
  const seq = await requestDraftRegeneration(campaignId)
  if (seq === null) return false
  await boss.send(CQ.reviewDraft, { campaignId, feedback, seq } satisfies ReviewDraftData, {
    singletonKey: `campaign-${campaignId}`,
  })
  return true
}

/** Collects the Kakao gift list, ranks what is new and sends a card for every pick. */
export async function runGiftCollect(
  send: (campaignId: number) => Promise<unknown>,
  now = new Date(),
) {
  const collected = await collectGiftCampaigns(now)
  const picked = await rankCollected(now)
  for (const id of picked) await send(id)
  return { ...collected, created: collected.created.length, picked }
}

export async function registerCampaignJobs(boss: PgBoss): Promise<void> {
  const tz = config.TZ_NAME
  await boss.createQueue(CQ.collect, {
    policy: 'stately',
    retryLimit: COLLECT_RETRY_LIMIT,
    retryDelay: 600,
  })
  await boss.createQueue(CQ.card, {
    policy: 'exclusive',
    retryLimit: CARD_RETRY_LIMIT,
    retryDelay: 30,
  })
  // Singleton: one draft at a time per campaign, later requests wait (they carry a newer seq).
  await boss.createQueue(CQ.reviewDraft, {
    policy: 'singleton',
    retryLimit: REVIEW_DRAFT_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  })
  await boss.createQueue(CQ.maintenance, { policy: 'stately', retryLimit: 0 })
  await boss.schedule(CQ.collect, config.GIFT_COLLECT_CRON, null, { tz })
  await boss.schedule(CQ.maintenance, '0 * * * *', null, { tz })

  await boss.work(CQ.collect, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, COLLECT_RETRY_LIMIT, '체험단 수집', async () => {
      console.log('[gift-collect]', await runGiftCollect((id) => sendCard(boss, id)))
    })
  })

  await boss.work<CampaignData>(CQ.card, async ([job]) => {
    if (!job) return
    const { campaignId } = job.data
    await alertOnFinalFailure(job, CARD_RETRY_LIMIT, `체험단 카드 전송 (#${campaignId})`, () =>
      sendCampaignCard(campaignId),
    )
  })

  await boss.work<ReviewDraftData>(CQ.reviewDraft, async ([job]) => {
    if (!job) return
    const { campaignId, feedback, seq } = job.data
    await alertOnFinalFailure(
      job,
      REVIEW_DRAFT_RETRY_LIMIT,
      `리뷰 초안 (#${campaignId})`,
      async () => {
        const written = await generateReviewDraft(campaignId, { feedback, seq })
        if (written) await sendDraft(campaignId)
      },
    )
  })

  // Hourly: expire cards past the apply deadline, then send due reminders during the day.
  await boss.work(CQ.maintenance, async () => {
    const now = new Date()
    const expired = await expireCampaigns(now)
    for (const c of expired) {
      if (c.review_chat_id != null && c.review_message_id != null) {
        await clearButtons(c.review_chat_id, c.review_message_id)
      }
    }
    const sent = isReminderHour(now, tz) ? await runCampaignReminders(sendCampaignMessage, now) : 0
    if (expired.length || sent)
      console.log('[campaign-maintenance]', { expired: expired.length, sent })
  })
}

/** Campaign and review handlers, registered through the review bot's `extend` hook. */
export function registerCampaignBots(boss: PgBoss, bot: Bot): void {
  registerCampaignBot(bot)
  registerReviewBot(bot, {
    onDraftRequested: async (id, feedback) => {
      if (!(await enqueueReviewDraft(boss, id, feedback))) {
        console.warn(`[campaign] draft request ignored: #${id} is not selected or under review`)
      }
    },
  })
}
