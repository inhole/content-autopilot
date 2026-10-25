import {
  CQ,
  enqueueReviewDraft,
  registerCampaignBots,
  registerCampaignJobs,
} from './campaigns/jobs.ts'
import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool } from './db/pool.ts'
import { createBoss, enqueueGenerate, enqueueRegeneration, Q, registerJobs } from './jobs.ts'
import { enqueueDigest, registerDigestBot, registerDigestJobs } from './pipeline/digest-jobs.ts'
import { registerReviveBot } from './pipeline/revive-bot.ts'
import {
  enqueueRevive,
  enqueueReviveCheck,
  registerReviveJobs,
  sendWithKeyboard,
} from './pipeline/revive-jobs.ts'
import { createReviewer } from './review/telegram.ts'
import { applySchedules } from './schedules.ts'
import { loadRuntimeSettings } from './settings.ts'
import {
  enqueueVideoReview,
  enqueueVideoScript,
  registerVideoBots,
  registerVideoJobs,
} from './video/jobs.ts'
import { runOpsJob } from './web/ops.ts'
import { startDashboard } from './web/server.ts'

let stopping = false
function onSignals(stop: (signal: string) => Promise<void>) {
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[worker] ${signal}, stopping`)
    await stop(signal)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

const applied = await migrate()
if (applied.length) console.log(`[db] applied ${applied.join(', ')}`)

const boss = createBoss()
await boss.start()

const reviewer = createReviewer({
  onRegenerate: async (topicId, feedback) => {
    if (!(await enqueueRegeneration(boss, topicId, feedback))) {
      console.warn(`[worker] regeneration ignored: topic ${topicId} has no draft under review`)
    }
  },
  onAddTopic: async (topicId) => {
    await enqueueGenerate(boss, { topicId })
  },
  extend: (bot) => {
    registerCampaignBots(boss, bot)
    registerReviveBot(bot, {
      onJudge: async () => {
        await enqueueReviveCheck(boss)
      },
      onRevive: async (postId) => {
        await enqueueRevive(boss, postId)
      },
    })
    registerDigestBot(bot, {
      onDigest: async () => {
        await enqueueDigest(boss)
      },
    })
    registerVideoBots(boss, bot)
  },
})
await registerJobs(boss, reviewer)
await registerCampaignJobs(boss)
await registerReviveJobs(boss, reviewer, sendWithKeyboard)
await registerDigestJobs(boss)
await registerVideoJobs(boss)
reviewer.start()
// Null when Telegram is not configured (login codes go there).
const dashboard = await startDashboard(
  {
    enqueueDraft: (id, feedback, revision) => enqueueReviewDraft(boss, id, feedback, revision),
  },
  {
    enqueueRegeneration: (topicId, feedback) => enqueueRegeneration(boss, topicId, feedback),
    enqueueGenerate: async (topicId) => {
      await enqueueGenerate(boss, { topicId })
    },
    enqueueRevive: async (postId) => {
      await enqueueRevive(boss, postId)
    },
    enqueueReviveCheck: async () => {
      await enqueueReviveCheck(boss)
    },
    enqueueDigest: async () => {
      await enqueueDigest(boss)
    },
    reviewer,
  },
  (name) => runOpsJob(name, { send: (queue) => boss.send(queue, null) }),
  () =>
    applySchedules(boss, {
      threadsCollect: Q.daily,
      giftCollect: CQ.collect,
      musinsaCollect: CQ.musinsaCollect,
    }),
  {
    enqueueReview: async (videoId) => {
      await enqueueVideoReview(boss, videoId)
    },
    enqueueScript: async (videoId, seq) => {
      await enqueueVideoScript(boss, videoId, seq)
    },
  },
)

const effective = await loadRuntimeSettings()
console.log(
  `[worker] started · collect "${effective.crons.threadsCollect}" ${config.TZ_NAME} · slots ${effective.publishSlots.join(', ')}` +
    ` · gift-collect "${effective.crons.giftCollect}" · musinsa-collect "${effective.crons.musinsaCollect}"` +
    ` · ${effective.dailyPostCount} posts/day · ${effective.campaignDailyMax} cards/source/day (${effective.source})` +
    (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : '') +
    (config.VIDEO_ENABLED ? ` · video-pick "${config.VIDEO_CRON}"` : '') +
    (config.VIDEO_PUBLISH_DRY_RUN ? ' · VIDEO DRY-RUN' : ''),
)
onSignals(async () => {
  await reviewer.stop()
  await dashboard?.close()
  await boss.stop({ graceful: true })
  await pool.end()
})
