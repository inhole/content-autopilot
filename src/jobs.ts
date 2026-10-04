import { PgBoss } from 'pg-boss'
import { config } from './config.ts'
import { collectAll } from './pipeline/collect.ts'
import { dedupeCollected } from './pipeline/dedupe.ts'
import { generatePost, SkipTopicError } from './pipeline/generate.ts'
import { duePostIds, publishPost } from './pipeline/publish.ts'
import { rankCollected } from './pipeline/rank.ts'
import type { Reviewer } from './review/telegram.ts'
import { refreshThreadsTokenIfNeeded, threadsTokenExpiry } from './threads/account.ts'

export const Q = {
  daily: 'daily-pipeline',
  generate: 'generate',
  review: 'review',
  publishDue: 'publish-due',
  publish: 'publish',
  refreshToken: 'refresh-token',
} as const

type GenerateData = { topicId: number; feedback?: string }
type PostData = { postId: number }

export function createBoss(): PgBoss {
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  })
  boss.on('error', (err) => console.error('[pg-boss]', err))
  return boss
}

export const enqueueGenerate = (boss: PgBoss, data: GenerateData) =>
  boss.send(Q.generate, data, { singletonKey: `topic-${data.topicId}` })

export async function registerJobs(boss: PgBoss, reviewer: Reviewer): Promise<void> {
  await boss.createQueue(Q.daily, { policy: 'singleton', retryLimit: 1 })
  await boss.createQueue(Q.generate, { retryLimit: 2, retryDelay: 60, retryBackoff: true })
  await boss.createQueue(Q.review, { retryLimit: 3, retryDelay: 30 })
  await boss.createQueue(Q.publishDue, { policy: 'singleton', retryLimit: 0 })
  // Retries come from publish-due re-finding the post, so the job itself never retries.
  await boss.createQueue(Q.publish, { policy: 'exclusive', retryLimit: 0 })
  await boss.createQueue(Q.refreshToken, { retryLimit: 2, retryDelay: 3600 })

  const tz = config.TZ_NAME
  await boss.schedule(Q.daily, config.COLLECT_CRON, null, { tz })
  await boss.schedule(Q.publishDue, '*/5 * * * *', null, { tz })
  await boss.schedule(Q.refreshToken, '0 4 * * *', null, { tz })

  await boss.work(Q.daily, async () => {
    const collected = await collectAll()
    const deduped = await dedupeCollected()
    const picked = await rankCollected()
    for (const topicId of picked) await enqueueGenerate(boss, { topicId })
    const failedFeeds = collected.filter((c) => c.error)
    console.log('[daily]', { collected, deduped, picked })
    if (failedFeeds.length) {
      await reviewer.notify(
        `⚠️ 수집 실패: ${failedFeeds.map((f) => `${f.source} (${f.error})`).join(', ')}`,
      )
    }
    if (picked.length === 0) await reviewer.notify('오늘은 새로 고른 주제가 없어요.')
  })

  await boss.work<GenerateData>(Q.generate, async ([job]) => {
    if (!job) return
    try {
      const postId = await generatePost(job.data.topicId, job.data.feedback)
      await boss.send(Q.review, { postId } satisfies PostData)
    } catch (err) {
      if (err instanceof SkipTopicError) {
        console.warn(`[generate] ${err.message}`)
        return
      }
      throw err
    }
  })

  await boss.work<PostData>(Q.review, async ([job]) => {
    if (job) await reviewer.sendForReview(job.data.postId)
  })

  await boss.work(Q.publishDue, async () => {
    for (const postId of await duePostIds()) {
      await boss.send(Q.publish, { postId } satisfies PostData, { singletonKey: `post-${postId}` })
    }
  })

  await boss.work<PostData>(Q.publish, async ([job]) => {
    if (!job) return
    const outcome = await publishPost(job.data.postId)
    if (outcome.kind === 'published') {
      await reviewer.notify(`🚀 #${job.data.postId} Threads 발행 완료`)
    } else if (outcome.kind === 'failed') {
      await reviewer.notify(`❌ #${job.data.postId} 발행 실패 (재시도 중단): ${outcome.error}`)
    } else if (outcome.kind === 'retry') {
      console.warn(`[publish] #${job.data.postId} will retry: ${outcome.error}`)
    }
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
}
