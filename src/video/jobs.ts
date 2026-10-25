import type { Bot } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { clearButtons } from '../campaigns/tg.ts'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { formatFinalFailure, isFinalAttempt } from '../jobs.ts'
import { getYouTubeApi, instagramTokenExpiry, refreshInstagramTokenIfNeeded } from './accounts.ts'
import { reschedulePublication } from './approve.ts'
import { cleanupVideoFiles, reclaimUploadAttempts } from './cleanup.ts'
import { collectVideoInsights } from './insights.ts'
import { pickVideo } from './pick.ts'
import { runRender, runScript } from './pipeline.ts'
import {
  duePublications,
  judgeShortStatus,
  markAlerted,
  markVerified,
  publishPublication,
  unalertedFailures,
  unverifiedShorts,
} from './publish.ts'
import {
  completePublishedVideos,
  expireUploads,
  expireVideos,
  failStage,
  isUnsentReview,
  loadVideo,
  recoverStuckStages,
  unsentReviews,
} from './store.ts'
import {
  formatVideoTime,
  notifyPublicationFailure,
  notifyVideo,
  publishedText,
  registerVideoBot,
  sendVideoReview,
} from './telegram.ts'
import { cleanupUploadTemp } from './upload.ts'

// Video queues (docs/plans/video.md 2). One cloud worker runs them next to the Threads and
// campaign queues; renders run one at a time (pg-boss localConcurrency defaults to 1).

export const VQ = {
  pick: 'video-pick',
  script: 'video-script',
  render: 'video-render',
  review: 'video-review',
  publishDue: 'video-publish-due',
  publish: 'video-publish',
  maintenance: 'video-maintenance',
  insights: 'video-insights',
  cleanup: 'video-cleanup',
  refreshToken: 'video-refresh-token',
} as const

const SCRIPT_RETRY_LIMIT = 2
const RENDER_RETRY_LIMIT = 2
const REVIEW_RETRY_LIMIT = 3

type PickData = { manual?: boolean }
type ScriptData = { videoId: number; seq: number }
type VideoData = { videoId: number }
type ReviewData = VideoData & { ifUnsent?: boolean }
type PublishData = { publicationId: number }

export const enqueueVideoScript = (boss: PgBoss, videoId: number, seq: number) =>
  boss.send(VQ.script, { videoId, seq } satisfies ScriptData, { singletonKey: `video-${videoId}` })
export const enqueueVideoRender = (boss: PgBoss, videoId: number) =>
  boss.send(VQ.render, { videoId } satisfies VideoData, { singletonKey: `video-${videoId}` })
export const enqueueVideoReview = (boss: PgBoss, videoId: number, ifUnsent?: boolean) =>
  boss.send(VQ.review, { videoId, ifUnsent } satisfies ReviewData)
export const enqueueVideoPick = (boss: PgBoss, manual = false) =>
  boss.send(VQ.pick, { manual } satisfies PickData)

/**
 * Runs a stage and, on the queue's last attempt, ends the video as FAILED and tells the owner.
 * A failing notify must never mask the original error.
 */
async function finalStage<T>(
  job: { retryCount: number },
  retryLimit: number,
  videoId: number,
  stage: 'SCRIPTING' | 'RENDERING',
  /** The failing request's ownership token; null when it never got that far (nothing to fail). */
  owner: () => number | null,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const token = owner()
    if (isFinalAttempt(job.retryCount, retryLimit) && token !== null) {
      try {
        if (await failStage(videoId, stage, token, (err as Error).message)) {
          await notifyVideo(formatFinalFailure(label, err))
        }
      } catch (notifyErr) {
        console.error(`[${label}] failed to record the failure`, notifyErr)
      }
    }
    throw err
  }
}

export async function createVideoQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(VQ.pick, { policy: 'stately', retryLimit: 0 })
  await boss.createQueue(VQ.script, {
    policy: 'singleton',
    retryLimit: SCRIPT_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  })
  await boss.createQueue(VQ.render, {
    policy: 'singleton',
    retryLimit: RENDER_RETRY_LIMIT,
    retryDelay: 120,
    expireInSeconds: 1800,
  })
  await boss.createQueue(VQ.review, { retryLimit: REVIEW_RETRY_LIMIT, retryDelay: 30 })
  await boss.createQueue(VQ.publishDue, { policy: 'singleton', retryLimit: 0 })
  // Retries come from the due sweep re-finding the row, like the Threads publish queue.
  await boss.createQueue(VQ.publish, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 1800 })
  await boss.createQueue(VQ.maintenance, { policy: 'singleton', retryLimit: 0 })
  await boss.createQueue(VQ.insights, { policy: 'singleton', retryLimit: 1, retryDelay: 600 })
  await boss.createQueue(VQ.cleanup, { policy: 'singleton', retryLimit: 0 })
  await boss.createQueue(VQ.refreshToken, { retryLimit: 2, retryDelay: 3600 })

  const tz = config.TZ_NAME
  if (config.VIDEO_ENABLED) await boss.schedule(VQ.pick, config.VIDEO_CRON, null, { tz })
  else await boss.unschedule(VQ.pick).catch(() => {})
  await boss.schedule(VQ.publishDue, '*/5 * * * *', null, { tz })
  await boss.schedule(VQ.maintenance, '15 * * * *', null, { tz })
  await boss.schedule(VQ.insights, '30 5 * * *', null, { tz })
  await boss.schedule(VQ.cleanup, '30 4 * * *', null, { tz })
  await boss.schedule(VQ.refreshToken, '10 4 * * *', null, { tz })
}

/** The sweep: due publications, overdue ones moved on, Shorts processing checks, failure alerts. */
export async function runPublishDue(boss: PgBoss, now = new Date()): Promise<void> {
  const completed = await completePublishedVideos()
  if (completed.length) console.log('[video-publish-due] completed videos', completed)
  const { due, overdue } = await duePublications(now)
  for (const id of overdue) {
    const at = await reschedulePublication(id, 'SCHEDULED', { now })
    if (at) {
      await notifyVideo(`⏭ 영상 발행 #${id}가 너무 늦어져서 ${formatVideoTime(at)}로 옮겼어요`)
    }
  }
  for (const publicationId of due) {
    await boss.send(VQ.publish, { publicationId } satisfies PublishData, {
      singletonKey: `video-pub-${publicationId}`,
    })
  }

  const shorts = await unverifiedShorts()
  if (shorts.length) {
    const youtube = await getYouTubeApi()
    for (const s of shorts) {
      try {
        const verdict = judgeShortStatus(
          await youtube.videoStatus(s.platform_media_id),
          config.YOUTUBE_PRIVACY,
          now.getTime() - s.published_at.getTime(),
        )
        if (!verdict.done) continue
        if (verdict.problem) await notifyVideo(`⚠️ 영상 #${s.video_id} Shorts: ${verdict.problem}`)
        await markVerified(s.id, verdict.problem)
      } catch (err) {
        console.warn(`[video-publish-due] Shorts check #${s.id} failed`, (err as Error).message)
      }
    }
  }

  for (const f of await unalertedFailures()) {
    await notifyPublicationFailure(f)
    await markAlerted(f.id)
  }
}

export async function registerVideoJobs(boss: PgBoss): Promise<void> {
  await createVideoQueues(boss)

  await boss.work<PickData>(VQ.pick, async ([job]) => {
    const result = await pickVideo()
    if (result.kind === 'created') {
      await notifyVideo(`🎬 #${result.postId} 글로 영상 #${result.videoId}을 만드는 중…`)
      await enqueueVideoScript(boss, result.videoId, 1)
    } else if (job?.data?.manual) {
      await notifyVideo(`🎬 ${result.reason}`)
    }
    console.log('[video-pick]', result)
  })

  await boss.work<ScriptData>(VQ.script, async ([job]) => {
    if (!job) return
    const { videoId, seq } = job.data
    await finalStage(
      job,
      SCRIPT_RETRY_LIMIT,
      videoId,
      'SCRIPTING',
      () => seq,
      `영상 원고 (#${videoId})`,
      async () => {
        if (await runScript(videoId, seq)) await enqueueVideoRender(boss, videoId)
      },
    )
  })

  await boss.work<VideoData>(VQ.render, async ([job]) => {
    if (!job) return
    const { videoId } = job.data
    let revision: number | null = null
    await finalStage(
      job,
      RENDER_RETRY_LIMIT,
      videoId,
      'RENDERING',
      () => revision,
      `영상 렌더 (#${videoId})`,
      async () => {
        const outcome = await runRender(videoId, {
          onJob: (r) => {
            revision = r
          },
        })
        if (outcome.kind === 'rendered' || outcome.kind === 'unchanged') {
          await enqueueVideoReview(boss, videoId)
        } else if (outcome.kind === 'failed') {
          const v = await loadVideo(videoId)
          await notifyVideo(
            `❌ 영상 #${videoId} 렌더 실패: ${outcome.error}\n원고부터 다시 만들려면 /video ${v?.post_id ?? ''}`,
          )
        }
        console.log('[video-render]', { videoId, outcome: outcome.kind })
      },
    )
  })

  await boss.work<ReviewData>(VQ.review, async ([job]) => {
    if (!job) return
    const { videoId, ifUnsent } = job.data
    if (ifUnsent && !(await isUnsentReview(videoId))) return
    try {
      await sendVideoReview(videoId)
    } catch (err) {
      if (isFinalAttempt(job.retryCount, REVIEW_RETRY_LIMIT)) {
        await notifyVideo(formatFinalFailure(`영상 검수 메시지 (#${videoId})`, err)).catch(() => {})
      }
      throw err
    }
  })

  await boss.work(VQ.publishDue, async () => {
    await runPublishDue(boss)
  })

  await boss.work<PublishData>(VQ.publish, async ([job]) => {
    if (!job) return
    const { publicationId } = job.data
    const outcome = await publishPublication(publicationId)
    if (outcome.kind === 'published') {
      const [row] = await query<{ video_id: number }>(
        'select video_id from video_publications where id = $1',
        [publicationId],
      )
      await notifyVideo(
        publishedText(row?.video_id ?? 0, outcome.platform, outcome.mediaId, outcome.permalink),
      )
    } else if (outcome.kind === 'failed') {
      // The sweep re-sends this alert until alerted_at is set, so a Telegram outage loses nothing.
      for (const f of await unalertedFailures()) {
        if (f.id !== publicationId) continue
        await notifyPublicationFailure(f)
        await markAlerted(f.id)
      }
    } else if (outcome.kind === 'retry') {
      console.warn(`[video-publish] #${publicationId} will retry: ${outcome.error}`)
    }
  })

  await boss.work(VQ.maintenance, async () => {
    const now = new Date()
    const expired = await expireVideos(now)
    for (const e of expired) {
      if (e.chatId != null && e.messageId != null) await clearButtons(e.chatId, e.messageId)
    }
    const unsent =
      config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID ? await unsentReviews(now) : []
    for (const id of unsent) await enqueueVideoReview(boss, id, true)
    const uploads = await expireUploads(now)
    const tmp = await cleanupUploadTemp(now.getTime())
    const stuck = await recoverStuckStages(now)
    for (const s of stuck.retry) {
      if (s.status === 'SCRIPTING') await enqueueVideoScript(boss, s.id, s.seq)
      else await enqueueVideoRender(boss, s.id)
    }
    for (const id of stuck.failed) {
      await notifyVideo(`❌ 영상 #${id}이 원고·렌더 단계에서 멈춰서 중단했어요`)
    }
    if (
      expired.length ||
      unsent.length ||
      uploads.length ||
      tmp ||
      stuck.retry.length ||
      stuck.failed.length
    ) {
      console.log('[video-maintenance]', {
        expired: expired.map((e) => e.id),
        expiredUploads: uploads,
        tmpRemoved: tmp,
        unsent,
        retried: stuck.retry.map((s) => s.id),
        failed: stuck.failed,
      })
    }
  })

  await boss.work(VQ.insights, async () => {
    console.log('[video-insights]', await collectVideoInsights())
  })

  await boss.work(VQ.cleanup, async () => {
    const result = await cleanupVideoFiles()
    if (result.deleted || result.failed) console.log('[video-cleanup]', result)
    const attempts = await reclaimUploadAttempts()
    if (attempts.deleted || attempts.failed) console.log('[video-cleanup] attempts', attempts)
  })

  await boss.work(VQ.refreshToken, async () => {
    try {
      console.log('[video-refresh-token]', await refreshInstagramTokenIfNeeded())
    } catch (err) {
      const expiry = await instagramTokenExpiry()
      await notifyVideo(
        `⚠️ Instagram 토큰 갱신 실패 (만료: ${expiry?.toISOString() ?? '알 수 없음'}): ${(err as Error).message}`,
      )
      throw err
    }
  })
}

/** Video handlers on the review bot (through its `extend` hook). */
export function registerVideoBots(boss: PgBoss, bot: Bot): void {
  registerVideoBot(bot, {
    onScript: async (videoId, seq) => {
      await enqueueVideoScript(boss, videoId, seq)
    },
    onRender: async (videoId) => {
      await enqueueVideoRender(boss, videoId)
    },
    onReview: async (videoId) => {
      await enqueueVideoReview(boss, videoId)
    },
    onPick: async () => {
      await enqueueVideoPick(boss, true)
    },
  })
}
