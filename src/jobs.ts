import { PgBoss } from 'pg-boss'
import { config } from './config.ts'
import { dbSsl } from './db/pool.ts'
import {
  dueChainPostIds,
  markChainAlerted,
  publishChain,
  unalertedChainFailures,
} from './pipeline/chain.ts'
import { collectAll } from './pipeline/collect.ts'
import { digestPostIdForTopic, regenerateDigest } from './pipeline/digest.ts'
import {
  generatePost,
  pendingShortlistedTopicIds,
  requestRegeneration,
  SkipTopicError,
} from './pipeline/generate.ts'
import { collectInsights, weeklyReport } from './pipeline/insights.ts'
import {
  expireDrafts,
  isUnsentReview,
  loadPendingDrafts,
  loadUnsentReviews,
  runReviewMaintenance,
} from './pipeline/maintenance.ts'
import { loadParts } from './pipeline/parts.ts'
import { duePostIds, publishPost } from './pipeline/publish.ts'
import { rankCollected } from './pipeline/rank.ts'
import { pollReplies } from './pipeline/replies.ts'
import type { Reviewer } from './review/telegram.ts'
import { refreshThreadsTokenIfNeeded, threadsTokenExpiry } from './threads/account.ts'

export const Q = {
  daily: 'daily-pipeline',
  // 'generate' was created with the default policy, which cannot be changed in place, so the
  // serialized per-topic queue lives under a new name. See LEGACY_GENERATE_QUEUE.
  generate: 'generate-v2',
  review: 'review',
  publishDue: 'publish-due',
  publish: 'publish',
  publishChain: 'publish-chain',
  chainAlert: 'chain-alert',
  refreshToken: 'refresh-token',
  pollReplies: 'poll-replies',
} as const

/** Queue name from before the policy change; still drained so in-flight jobs are not lost. */
const LEGACY_GENERATE_QUEUE = 'generate'

// Retry limits live here so the "last attempt" alert check uses the same numbers as createQueue.
const DAILY_RETRY_LIMIT = 1
const GENERATE_RETRY_LIMIT = 2
const REVIEW_RETRY_LIMIT = 3

/** pg-boss counts retries from 0, so the attempt with retryCount === retryLimit is the last one. */
export function isFinalAttempt(retryCount: number, retryLimit: number): boolean {
  return retryCount >= retryLimit
}

export function formatFinalFailure(label: string, err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
  const short = message.length > 300 ? `${message.slice(0, 300)}…` : message
  return `❌ ${label} 실패 (재시도 소진): ${short}`
}

/**
 * Runs `fn` and, if it throws on the queue's last attempt, tells the owner before rethrowing.
 * Without this a job that exhausts its retries would only show up in logs. A failing notify must
 * never mask the original error.
 */
async function alertOnFinalFailure<T>(
  job: { retryCount: number },
  retryLimit: number,
  label: string,
  reviewer: Reviewer,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isFinalAttempt(job.retryCount, retryLimit)) {
      try {
        await reviewer.notify(formatFinalFailure(label, err))
      } catch (notifyErr) {
        console.error(`[${label}] failed to send failure alert`, notifyErr)
      }
    }
    throw err
  }
}

/** `regenerate` is absent on jobs queued before it existed; feedback implied a regeneration then. */
type GenerateData = { topicId: number; feedback?: string; regenerate?: boolean; seq?: number }
type PostData = { postId: number }
/**
 * A review job sent by the recovery sweep. It only sends when the draft is still waiting without a
 * registered review message: the review queue has the standard policy, so it cannot drop a
 * duplicate of a review job that is still queued, and sendForReview is not idempotent.
 */
type ReviewData = PostData & { ifUnsent?: boolean }
type ChainAlertData = { postId: number; error: string }

export function createBoss(): PgBoss {
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    ssl: dbSsl,
    max: 5,
  })
  boss.on('error', (err) => console.error('[pg-boss]', err))
  return boss
}

// The singleton queue policy runs at most one job per singletonKey at a time while keeping
// the rest queued, so feedback sent during a running generation is processed afterwards.
export const enqueueGenerate = (boss: PgBoss, data: GenerateData) =>
  boss.send(Q.generate, data, { singletonKey: `topic-${data.topicId}` })

/** Queues a regeneration that supersedes any earlier, still pending or retrying one. */
export async function enqueueRegeneration(
  boss: PgBoss,
  topicId: number,
  feedback?: string,
): Promise<boolean> {
  const seq = await requestRegeneration(topicId)
  if (seq === null) return false
  await enqueueGenerate(boss, { topicId, feedback, regenerate: true, seq })
  return true
}

export async function registerJobs(boss: PgBoss, reviewer: Reviewer): Promise<void> {
  await boss.createQueue(Q.daily, { policy: 'singleton', retryLimit: DAILY_RETRY_LIMIT })
  const generateQueue = { retryLimit: GENERATE_RETRY_LIMIT, retryDelay: 60, retryBackoff: true }
  await boss.createQueue(Q.generate, { ...generateQueue, policy: 'singleton' })
  await boss.createQueue(LEGACY_GENERATE_QUEUE, generateQueue)
  await boss.createQueue(Q.review, { retryLimit: REVIEW_RETRY_LIMIT, retryDelay: 30 })
  await boss.createQueue(Q.publishDue, { policy: 'singleton', retryLimit: 0 })
  // Retries come from publish-due re-finding the post, so the job itself never retries.
  await boss.createQueue(Q.publish, { policy: 'exclusive', retryLimit: 0 })
  // Same model for the follow-up replies of a thread chain: the sweep re-finds unfinished parts.
  await boss.createQueue(Q.publishChain, { policy: 'exclusive', retryLimit: 0 })
  // The alert (and its retry button) is the owner's only way back for failed parts, so it gets its
  // own retrying job, and publish-due re-sends it until post_parts.alerted_at says it went out.
  // Exclusive: one queued or active alert per post (singletonKey), however long Telegram is down.
  await boss.createQueue(Q.chainAlert, {
    policy: 'exclusive',
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  })
  await boss.createQueue(Q.refreshToken, { retryLimit: 2, retryDelay: 3600 })

  const tz = config.TZ_NAME
  await boss.schedule(Q.daily, config.COLLECT_CRON, null, { tz })
  await boss.schedule(Q.publishDue, '*/5 * * * *', null, { tz })
  await boss.schedule(Q.refreshToken, '0 4 * * *', null, { tz })

  const runDaily = async () => {
    const collected = await collectAll()
    const picked = await rankCollected()
    // Includes leftovers from an earlier crash between ranking and enqueueing.
    const toGenerate = await pendingShortlistedTopicIds()
    for (const topicId of toGenerate) await enqueueGenerate(boss, { topicId })
    const failedFeeds = collected.filter((c) => c.error)
    console.log('[daily]', { collected, picked, toGenerate })
    if (failedFeeds.length) {
      await reviewer.notify(
        `⚠️ 수집 실패: ${failedFeeds.map((f) => `${f.source} (${f.error})`).join(', ')}`,
      )
    }
    if (picked.length === 0) await reviewer.notify('오늘은 새로 고른 주제가 없어요.')
  }
  await boss.work(Q.daily, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, DAILY_RETRY_LIMIT, '일일 파이프라인', reviewer, runDaily)
  })

  const handleGenerate = async ([job]: { data: GenerateData; retryCount: number }[]) => {
    if (!job) return
    const { topicId, feedback, seq } = job.data
    const label = `초안 생성 (topic #${topicId})`
    await alertOnFinalFailure(job, GENERATE_RETRY_LIMIT, label, reviewer, () =>
      runGenerate(topicId, feedback, seq, job.data.regenerate),
    )
  }
  const runGenerate = async (
    topicId: number,
    feedback: string | undefined,
    seq: number | undefined,
    regenerate: boolean | undefined,
  ) => {
    try {
      // A digest's topic only ever gets regenerations; its text is rebuilt from the member posts.
      const digestId = await digestPostIdForTopic(topicId)
      if (digestId !== null) {
        const done = await regenerateDigest(digestId, { feedback, seq })
        if (done !== null) await boss.send(Q.review, { postId: done } satisfies PostData)
        return
      }
      const postId = await generatePost(topicId, {
        feedback,
        seq,
        regenerate: regenerate ?? Boolean(feedback),
      })
      if (postId !== null) await boss.send(Q.review, { postId } satisfies PostData)
    } catch (err) {
      if (err instanceof SkipTopicError) {
        console.warn(`[generate] ${err.message}`)
        return
      }
      throw err
    }
  }
  await boss.work<GenerateData>(Q.generate, handleGenerate)
  // Forward instead of running here, so legacy jobs go through the same per-topic serialization.
  await boss.work<GenerateData>(LEGACY_GENERATE_QUEUE, async ([job]) => {
    if (job) await enqueueGenerate(boss, job.data)
  })

  await boss.work<ReviewData>(Q.review, async ([job]) => {
    if (!job) return
    const { postId, ifUnsent } = job.data
    if (ifUnsent && !(await isUnsentReview(postId))) return
    await alertOnFinalFailure(
      job,
      REVIEW_RETRY_LIMIT,
      `검수 메시지 전송 (#${postId})`,
      reviewer,
      () => reviewer.sendForReview(postId),
    )
  })

  const enqueueChain = (postId: number) =>
    boss.send(Q.publishChain, { postId } satisfies PostData, { singletonKey: `chain-${postId}` })

  const enqueueChainAlert = (data: ChainAlertData) =>
    boss.send(Q.chainAlert, data, { singletonKey: `chain-alert-${data.postId}` })

  await boss.work(Q.publishDue, async () => {
    for (const postId of await duePostIds()) {
      await boss.send(Q.publish, { postId } satisfies PostData, { singletonKey: `post-${postId}` })
    }
    for (const postId of await dueChainPostIds()) await enqueueChain(postId)
    for (const alert of await unalertedChainFailures()) await enqueueChainAlert(alert)
  })

  await boss.work<PostData>(Q.publish, async ([job]) => {
    if (!job) return
    const outcome = await publishPost(job.data.postId)
    if (outcome.kind === 'published') {
      await reviewer.notify(`🚀 #${job.data.postId} Threads 발행 완료`)
      // Start the replies right away instead of waiting for the next publish-due sweep.
      if ((await loadParts(job.data.postId)).length > 0) await enqueueChain(job.data.postId)
    } else if (outcome.kind === 'failed') {
      await reviewer.notify(`❌ #${job.data.postId} 발행 실패 (재시도 중단): ${outcome.error}`)
    } else if (outcome.kind === 'retry') {
      console.warn(`[publish] #${job.data.postId} will retry: ${outcome.error}`)
    }
  })

  await boss.work<PostData>(Q.publishChain, async ([job]) => {
    if (!job) return
    const { postId } = job.data
    const outcome = await publishChain(postId)
    if (outcome.kind === 'failed') {
      await enqueueChainAlert({ postId, error: outcome.error })
    } else if (outcome.kind === 'done' && outcome.published > 0) {
      await reviewer.notify(`🧵 #${postId} 답글 ${outcome.published}개 발행 완료`)
    } else if (outcome.kind === 'retry') {
      console.warn(`[publish-chain] #${postId} will retry: ${outcome.error}`)
    }
  })

  await boss.work<ChainAlertData>(Q.chainAlert, async ([job]) => {
    if (!job) return
    // The parts may have been retried or alerted since this job was queued: send only what is due.
    const [due] = await unalertedChainFailures(job.data.postId)
    if (!due) return
    await reviewer.notifyChainFailure(due.postId, due.error)
    await markChainAlerted(due.postId)
  })

  await boss.work(Q.refreshToken, async () => {
    try {
      const result = await refreshThreadsTokenIfNeeded()
      console.log('[refresh-token]', result)
    } catch (err) {
      const expiry = await threadsTokenExpiry()
      await reviewer.notify(
        `⚠️ Threads 토큰 갱신 실패 (만료: ${expiry?.toISOString() ?? '알 수 없음'}): ${(err as Error).message}`,
      )
      throw err
    }
  })

  // Hourly: expire stale drafts and send the 09:00 / 18:00 reminder (decided from the local hour).
  const maintenanceQueue = 'review-maintenance'
  await boss.createQueue(maintenanceQueue, { policy: 'singleton', retryLimit: 0 })
  await boss.schedule(maintenanceQueue, '0 * * * *', null, { tz })
  await boss.work(maintenanceQueue, async () => {
    const result = await runReviewMaintenance(
      {
        loadPending: loadPendingDrafts,
        expire: (ids) => expireDrafts(ids, new Date()),
        retire: (ids) => reviewer.retireReviewMessages(ids),
        notify: (text) => reviewer.notify(text),
      },
      new Date(),
      tz,
    )
    // Without Telegram no review message is ever registered, so there is nothing to recover.
    const unsent =
      config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
        ? await loadUnsentReviews(new Date())
        : []
    for (const postId of unsent) {
      await boss.send(Q.review, { postId, ifUnsent: true } satisfies ReviewData)
    }
    console.log('[review-maintenance]', { ...result, resentReviews: unsent })
  })

  // Insights: snapshot numbers daily before the 06:00 pipeline; report every Monday morning.
  const insightsQueue = 'collect-insights'
  const reportQueue = 'weekly-report'
  await boss.createQueue(insightsQueue, { policy: 'singleton', retryLimit: 1, retryDelay: 600 })
  await boss.createQueue(reportQueue, { policy: 'singleton', retryLimit: 1, retryDelay: 600 })
  await boss.schedule(insightsQueue, '0 5 * * *', null, { tz })
  await boss.schedule(reportQueue, '0 9 * * 1', null, { tz })
  await boss.work(insightsQueue, async () => {
    console.log('[collect-insights]', await collectInsights())
  })
  await boss.work(reportQueue, async () => {
    // Fresh numbers first; a failed collection still leaves the last snapshots to report on.
    try {
      await collectInsights()
    } catch (err) {
      console.error('[weekly-report] collecting insights failed', err)
    }
    await reviewer.notify(await weeklyReport())
  })

  // Every 5 minutes: forward new replies on recent posts to Telegram. The next tick is the retry.
  await boss.createQueue(Q.pollReplies, { policy: 'singleton', retryLimit: 0 })
  await boss.schedule(Q.pollReplies, '*/5 * * * *', null, { tz })
  await boss.work(Q.pollReplies, async () => {
    const fresh = await pollReplies((text) => reviewer.notifyWithId(text))
    if (fresh.length) console.log('[poll-replies]', { notified: fresh.length })
  })
}
