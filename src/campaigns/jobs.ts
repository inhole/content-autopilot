import type { Bot } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { formatFinalFailure, isFinalAttempt } from '../jobs.ts'
import { localHour } from '../lib/time.ts'
import { applyCampaign, dueApplyIds } from './apply.ts'
import { generateBlogDraft, requestDraftRegeneration } from './blog.ts'
import { dueBlogSaveIds, saveBlogDraft } from './blog-save.ts'
import { registerBlogBot, sendDraftCard, sendSaveResult } from './blog-telegram.ts'
import { addCampaignUrl, collectFromKakao } from './collect.ts'
import { rankDetailed, rewriteApplyMessage } from './rank.ts'
import { runCampaignReminders } from './reminders.ts'
import { expirePastDeadline } from './review.ts'
import { fetchCampaignDetail } from './revu.ts'
import { checkSelections } from './selection.ts'
import { heartbeat } from './store.ts'
import { registerCampaignBot, sendApplyResult, sendCampaignCard } from './telegram.ts'
import { clearButtons, sendCampaignMessage } from './tg.ts'

export type WorkerRole = 'cloud' | 'local'

export const CQ = {
  rank: 'campaign-rank',
  card: 'campaign-card',
  rewrite: 'campaign-rewrite',
  blogDraft: 'blog-draft',
  maintenance: 'campaign-maintenance',
  kakaoCollect: 'kakao-collect',
  fetch: 'campaign-fetch',
  sweep: 'campaign-sweep',
  apply: 'campaign-apply',
  selection: 'campaign-selection',
  blogSave: 'blog-save',
} as const

// Same idea as the retry limits in src/jobs.ts: shared by createQueue and the final-failure check.
const CARD_RETRY_LIMIT = 3
const FETCH_RETRY_LIMIT = 2
const SELECTION_RETRY_LIMIT = 1
const BLOG_DRAFT_RETRY_LIMIT = 2

/** A DISCOVERED campaign untouched this long lost its campaign-fetch job; the sweep re-sends it. */
export const LOST_FETCH_MINUTES = 30
/** Reminders go out between these local hours (inclusive) so nothing pings at night. */
export const REMINDER_FIRST_HOUR = 9
export const REMINDER_LAST_HOUR = 21
/** Delay before ranking, so several fetches finishing together batch into one rank run. */
const RANK_DELAY_SECONDS = 60

type CampaignData = { campaignId: number }
type RewriteData = { campaignId: number; feedback: string }
type BlogDraftData = { campaignId: number; feedback?: string; seq?: number }

const sendCampaignId = (boss: PgBoss, name: string, campaignId: number) =>
  boss.send(name, { campaignId } satisfies CampaignData, { singletonKey: `campaign-${campaignId}` })

export function isReminderHour(now: Date, tz: string): boolean {
  const hour = localHour(now, tz)
  return hour >= REMINDER_FIRST_HOUR && hour <= REMINDER_LAST_HOUR
}

/** DISCOVERED campaigns whose campaign-fetch job seems lost (not updated for a while). */
export async function lostDiscoveredIds(now = new Date()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from campaigns
     where status = 'DISCOVERED'
       and updated_at < $1::timestamptz - make_interval(mins => $2)
     order by id`,
    [now, LOST_FETCH_MINUTES],
  )
  return rows.map((r) => r.id)
}

/**
 * Runs `fn` and, if it throws on the queue's last attempt, tells the owner before rethrowing.
 * Campaign queues alert through the send-only API so the local worker (no polling) can use it too.
 */
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

/**
 * Creates every campaign queue and schedule. Idempotent and role independent: whichever worker
 * starts first sets everything up, so a queue is never missing when the other side sends to it.
 */
export async function createCampaignQueues(boss: PgBoss): Promise<void> {
  const tz = config.TZ_NAME
  // cloud
  await boss.createQueue(CQ.rank, { policy: 'stately', retryLimit: 1, retryDelay: 60 })
  await boss.createQueue(CQ.card, {
    policy: 'exclusive',
    retryLimit: CARD_RETRY_LIMIT,
    retryDelay: 30,
  })
  await boss.createQueue(CQ.rewrite, { policy: 'singleton', retryLimit: 1 })
  await boss.createQueue(CQ.blogDraft, {
    policy: 'singleton',
    retryLimit: BLOG_DRAFT_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  })
  await boss.createQueue(CQ.maintenance, { policy: 'stately', retryLimit: 0 })
  // local
  await boss.createQueue(CQ.kakaoCollect, { policy: 'stately', retryLimit: 0 })
  await boss.createQueue(CQ.fetch, {
    policy: 'exclusive',
    retryLimit: FETCH_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  })
  await boss.createQueue(CQ.sweep, { policy: 'stately', retryLimit: 0 })
  // Retries come from the sweep re-finding the row, so these jobs never retry themselves.
  await boss.createQueue(CQ.apply, { policy: 'exclusive', retryLimit: 0 })
  await boss.createQueue(CQ.selection, {
    policy: 'stately',
    retryLimit: SELECTION_RETRY_LIMIT,
    retryDelay: 600,
  })
  await boss.createQueue(CQ.blogSave, { policy: 'exclusive', retryLimit: 0 })

  await boss.schedule(CQ.maintenance, '0 * * * *', null, { tz })
  await boss.schedule(CQ.kakaoCollect, config.KAKAO_COLLECT_CRON, null, { tz })
  await boss.schedule(CQ.sweep, '*/5 * * * *', null, { tz })
  await boss.schedule(CQ.selection, '0 10,19 * * *', null, { tz })
}

/** Wires the cloud worker's Telegram bot handlers to the queues. */
export function registerCampaignBots(boss: PgBoss, bot: Bot): void {
  registerCampaignBot(bot, {
    onApproveApply: async (id) => {
      await sendCampaignId(boss, CQ.apply, id)
    },
    onRewriteApplyMessage: async (campaignId, feedback) => {
      await boss.send(CQ.rewrite, { campaignId, feedback } satisfies RewriteData, {
        singletonKey: `campaign-${campaignId}`,
      })
    },
    onAddCampaign: async (id) => {
      await sendCampaignId(boss, CQ.fetch, id)
    },
    addCampaignUrl,
  })
  registerBlogBot(bot, {
    // The sequence number is taken now, not inside the job, so an older queued request cannot
    // overwrite a newer one (same model as enqueueRegeneration in src/jobs.ts).
    onDraftRequested: async (campaignId, feedback) => {
      const seq = await requestDraftRegeneration(campaignId)
      await boss.send(
        CQ.blogDraft,
        { campaignId, feedback, ...(seq !== null ? { seq } : {}) } satisfies BlogDraftData,
        { singletonKey: `campaign-${campaignId}` },
      )
    },
    onDraftApproved: async (id) => {
      await sendCampaignId(boss, CQ.blogSave, id)
    },
  })
}

/** Registers the workers of `role`'s queues only; the other role's jobs wait for its worker. */
export async function registerCampaignJobs(boss: PgBoss, role: WorkerRole): Promise<void> {
  if (role === 'cloud') await registerCloudJobs(boss)
  else await registerLocalJobs(boss)
}

async function registerCloudJobs(boss: PgBoss): Promise<void> {
  await boss.work(CQ.rank, async ([job]) => {
    if (!job) return
    const shortlisted = await rankDetailed()
    for (const campaignId of shortlisted) await sendCampaignId(boss, CQ.card, campaignId)
    console.log('[campaign-rank]', { shortlisted })
  })

  await boss.work<CampaignData>(CQ.card, async ([job]) => {
    if (!job) return
    const { campaignId } = job.data
    await alertOnFinalFailure(job, CARD_RETRY_LIMIT, `체험단 카드 전송 (#${campaignId})`, () =>
      sendCampaignCard(campaignId),
    )
  })

  await boss.work<RewriteData>(CQ.rewrite, async ([job]) => {
    if (!job) return
    const { campaignId, feedback } = job.data
    if (await rewriteApplyMessage(campaignId, feedback)) await sendCampaignCard(campaignId)
  })

  await boss.work<BlogDraftData>(CQ.blogDraft, async ([job]) => {
    if (!job) return
    const { campaignId, feedback, seq } = job.data
    await alertOnFinalFailure(
      job,
      BLOG_DRAFT_RETRY_LIMIT,
      `후기 초안 작성 (#${campaignId})`,
      async () => {
        const written = await generateBlogDraft(campaignId, {
          feedback,
          ...(seq !== undefined ? { seq } : {}),
        })
        if (written) await sendDraftCard(campaignId)
      },
    )
  })

  await boss.work(CQ.maintenance, async () => {
    const now = new Date()
    const expired = await expirePastDeadline(now)
    for (const c of expired) {
      if (c.review_chat_id != null && c.review_message_id != null) {
        await clearButtons(c.review_chat_id, c.review_message_id)
      }
    }
    const reminded = isReminderHour(now, config.TZ_NAME)
      ? await runCampaignReminders(sendCampaignMessage, now)
      : null
    console.log('[campaign-maintenance]', { expired: expired.length, reminded })
  })
}

async function registerLocalJobs(boss: PgBoss): Promise<void> {
  await boss.work(CQ.kakaoCollect, async ([job]) => {
    if (!job) return
    if (config.KAKAO_ROOMS.length === 0) {
      console.warn('[kakao-collect] KAKAO_ROOMS is empty, skipping')
      return
    }
    const results = await collectFromKakao()
    for (const r of results) {
      for (const campaignId of r.newCampaignIds) await sendCampaignId(boss, CQ.fetch, campaignId)
    }
    const failed = results.filter((r) => r.error)
    if (failed.length) {
      await sendCampaignMessage(
        `⚠️ 카카오톡 읽기 실패: ${failed.map((r) => `${r.room} (${r.error})`).join(', ')}`,
      )
    }
    console.log('[kakao-collect]', results)
  })

  await boss.work<CampaignData>(CQ.fetch, async ([job]) => {
    if (!job) return
    const { campaignId } = job.data
    await alertOnFinalFailure(
      job,
      FETCH_RETRY_LIMIT,
      `공고 상세 읽기 (#${campaignId})`,
      async () => {
        const outcome = await fetchCampaignDetail(campaignId)
        console.log(`[campaign-fetch] #${campaignId} ${outcome}`)
        // stately: a send while a rank is queued is dropped, so a burst of fetches ranks once.
        if (outcome === 'detailed') {
          await boss.send(CQ.rank, null, { startAfter: RANK_DELAY_SECONDS })
        }
      },
    )
  })

  await boss.work(CQ.sweep, async () => {
    await heartbeat('local')
    const apply = await dueApplyIds()
    const save = await dueBlogSaveIds()
    const lost = await lostDiscoveredIds()
    for (const id of apply) await sendCampaignId(boss, CQ.apply, id)
    for (const id of save) await sendCampaignId(boss, CQ.blogSave, id)
    for (const id of lost) await sendCampaignId(boss, CQ.fetch, id)
    if (apply.length + save.length + lost.length > 0) {
      console.log('[campaign-sweep]', { apply, save, lost })
    }
  })

  await boss.work<CampaignData>(CQ.apply, async ([job]) => {
    if (!job) return
    const { campaignId } = job.data
    const outcome = await applyCampaign(campaignId)
    if (outcome.kind === 'applied' || outcome.kind === 'dry-run' || outcome.kind === 'failed') {
      await sendApplyResult(campaignId, { ...outcome, kind: outcome.kind })
    } else {
      console.warn(`[campaign-apply] #${campaignId} ${outcome.kind}: ${outcome.error ?? ''}`)
    }
  })

  await boss.work(CQ.selection, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, SELECTION_RETRY_LIMIT, '체험단 선정 확인', async () => {
      // Selected congratulations are sent by the hourly reminders.
      console.log('[campaign-selection]', await checkSelections())
    })
  })

  await boss.work<CampaignData>(CQ.blogSave, async ([job]) => {
    if (!job) return
    const { campaignId } = job.data
    const outcome = await saveBlogDraft(campaignId)
    if (outcome.kind === 'saved' || outcome.kind === 'dry-run' || outcome.kind === 'failed') {
      await sendSaveResult(campaignId, outcome)
    } else {
      console.warn(`[blog-save] #${campaignId} ${outcome.kind}: ${outcome.error ?? ''}`)
    }
  })
}
