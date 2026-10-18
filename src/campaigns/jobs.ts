import type { Bot } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { AsideNotRunningError } from '../aside/client.ts'
import { config } from '../config.ts'
import { formatFinalFailure, isFinalAttempt } from '../jobs.ts'
import { localHour } from '../lib/time.ts'
import { collectGiftCampaigns, collectMusinsaCampaigns } from './collect.ts'
import { MusinsaLoginError } from './musinsa.ts'
import { rankCollected } from './rank.ts'
import { runCampaignReminders } from './reminders.ts'
import { expireCampaigns } from './review.ts'
import { generateReviewDraft, requestDraftRegeneration } from './review-draft.ts'
import { registerReviewBot, sendDraft } from './review-telegram.ts'
import { campaignIdsByStatus } from './store.ts'
import { registerCampaignBot, sendCampaignCard } from './telegram.ts'
import { clearButtons, sendCampaignMessage } from './tg.ts'

export const CQ = {
  collect: 'gift-collect',
  card: 'campaign-card',
  reviewDraft: 'review-draft',
  maintenance: 'campaign-maintenance',
  // Musinsa is read on the owner's PC (role local); ranking and cards stay on the cloud worker.
  musinsaCollect: 'musinsa-collect',
  rank: 'campaign-rank',
} as const

/** Queues each worker role works. Disjoint: a job is only ever handled by the role that owns it. */
export const LOCAL_QUEUES: readonly string[] = [CQ.musinsaCollect]
export const CLOUD_QUEUES: readonly string[] = [
  CQ.collect,
  CQ.card,
  CQ.reviewDraft,
  CQ.maintenance,
  CQ.rank,
]

// Same idea as the retry limits in src/jobs.ts: shared by createQueue and the final-failure check.
const COLLECT_RETRY_LIMIT = 1
const CARD_RETRY_LIMIT = 3
const MUSINSA_RETRY_LIMIT = 1
const RANK_RETRY_LIMIT = 1
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

/**
 * Sends a card for every SHORTLISTED campaign, not just this run's picks: a pick whose card was
 * never queued (a later source failed to rank, an enqueue failed) is still in the table, and the
 * row is the source of truth. The card queue's singletonKey drops duplicates.
 */
export async function sendPendingCards(send: (campaignId: number) => Promise<unknown>) {
  for (const id of await campaignIdsByStatus('SHORTLISTED')) await send(id)
}

/** Collects the Kakao gift list, ranks what is new and sends a card for every pick. */
export async function runGiftCollect(
  send: (campaignId: number) => Promise<unknown>,
  now = new Date(),
) {
  const collected = await collectGiftCampaigns(now)
  const picked = await rankCollected(now)
  await sendPendingCards(send)
  return { ...collected, created: collected.created.length, picked }
}

/** Min gap between two "log in to Musinsa" Telegram alerts. */
export const LOGIN_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * Rate limiter for the login alert. Kept in memory per process on purpose: only the single local
 * worker alerts, so no shared state or migration is needed. A restart may repeat an alert once,
 * which is harmless because the owner has to act on it anyway.
 */
export function createLoginAlerter(
  send: (text: string) => Promise<unknown>,
  intervalMs = LOGIN_ALERT_INTERVAL_MS,
) {
  let last = 0
  return async (reason: string, now = Date.now()): Promise<boolean> => {
    if (last && now - last < intervalMs) return false
    last = now
    await send(
      `무신사 체험단 수집을 못 했어요: ${reason}\nPC에서 Aside를 켜고 musinsa.com에 로그인해 주세요. (다음 알림은 12시간 뒤)`,
    )
    return true
  }
}

/**
 * Collects the Musinsa list on the owner's PC, then asks the cloud worker to rank and send cards.
 * A logged-out or closed Aside is not retried: the owner is told (rate-limited) and the run ends.
 */
export async function runMusinsaCollect(
  deps: {
    collect?: typeof collectMusinsaCampaigns
    enqueueRank: () => Promise<unknown>
    alert: (reason: string) => Promise<unknown>
  },
  now = new Date(),
) {
  try {
    const collected = await (deps.collect ?? collectMusinsaCampaigns)(now)
    await deps.enqueueRank()
    return { ...collected, created: collected.created.length }
  } catch (err) {
    if (err instanceof MusinsaLoginError) {
      await deps.alert('무신사에 로그인되어 있지 않아요.')
      return { skipped: 'logged-out' as const }
    }
    if (err instanceof AsideNotRunningError) {
      await deps.alert('Aside가 실행 중이 아니에요.')
      return { skipped: 'aside-not-running' as const }
    }
    throw err
  }
}

/** Creates every campaign queue and schedule. Idempotent; both worker roles call it. */
export async function createCampaignQueues(boss: PgBoss): Promise<void> {
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
  await boss.createQueue(CQ.musinsaCollect, {
    policy: 'stately',
    retryLimit: MUSINSA_RETRY_LIMIT,
    retryDelay: 600,
  })
  await boss.createQueue(CQ.rank, {
    policy: 'stately',
    retryLimit: RANK_RETRY_LIMIT,
    retryDelay: 60,
  })
  await boss.schedule(CQ.collect, config.GIFT_COLLECT_CRON, null, { tz })
  await boss.schedule(CQ.maintenance, '0 * * * *', null, { tz })
  await boss.schedule(CQ.musinsaCollect, config.MUSINSA_COLLECT_CRON, null, { tz })
}

/** Local (owner's PC) role: only the Musinsa collector. No Telegram polling, no Threads. */
export async function registerLocalCampaignJobs(boss: PgBoss): Promise<void> {
  await createCampaignQueues(boss)
  const alert = createLoginAlerter(sendCampaignMessage)
  await boss.work(CQ.musinsaCollect, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, MUSINSA_RETRY_LIMIT, '무신사 체험단 수집', async () => {
      console.log(
        '[musinsa-collect]',
        await runMusinsaCollect({
          enqueueRank: () => boss.send(CQ.rank, null),
          alert: (reason) => alert(reason),
        }),
      )
    })
  })
}

/** Cloud role: gift collector, ranking, cards, review drafts and maintenance. */
export async function registerCampaignJobs(boss: PgBoss): Promise<void> {
  const tz = config.TZ_NAME
  await createCampaignQueues(boss)

  await boss.work(CQ.collect, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, COLLECT_RETRY_LIMIT, '체험단 수집', async () => {
      console.log('[gift-collect]', await runGiftCollect((id) => sendCard(boss, id)))
    })
  })

  // Ranks whatever is COLLECTED (gift and Musinsa rows alike) and sends a card for every pick.
  await boss.work(CQ.rank, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, RANK_RETRY_LIMIT, '체험단 선별', async () => {
      const picked = await rankCollected()
      await sendPendingCards((id) => sendCard(boss, id))
      console.log('[campaign-rank]', { picked })
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
