import { registerCampaignBots, registerCampaignJobs } from './campaigns/jobs.ts'
import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool } from './db/pool.ts'
import { createBoss, enqueueGenerate, enqueueRegeneration, registerJobs } from './jobs.ts'
import { enqueueDigest, registerDigestBot, registerDigestJobs } from './pipeline/digest-jobs.ts'
import { registerReviveBot } from './pipeline/revive-bot.ts'
import {
  enqueueRevive,
  enqueueReviveCheck,
  registerReviveJobs,
  sendWithKeyboard,
} from './pipeline/revive-jobs.ts'
import { createReviewer } from './review/telegram.ts'
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
  },
})
await registerJobs(boss, reviewer)
await registerCampaignJobs(boss)
await registerReviveJobs(boss, reviewer, sendWithKeyboard)
await registerDigestJobs(boss)
reviewer.start()
// Null when DASHBOARD_PASSWORD is unset.
const dashboard = await startDashboard()

console.log(
  `[worker] started · collect "${config.COLLECT_CRON}" ${config.TZ_NAME} · slots ${config.PUBLISH_SLOTS.join(', ')}` +
    ` · gift-collect "${config.GIFT_COLLECT_CRON}" · musinsa-collect "${config.MUSINSA_COLLECT_CRON}"` +
    (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : ''),
)
onSignals(async () => {
  await reviewer.stop()
  await dashboard?.close()
  await boss.stop({ graceful: true })
  await pool.end()
})
