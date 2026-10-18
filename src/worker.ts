import {
  registerCampaignBots,
  registerCampaignJobs,
  registerLocalCampaignJobs,
} from './campaigns/jobs.ts'
import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool, query } from './db/pool.ts'
import { createBoss, enqueueGenerate, enqueueRegeneration, registerJobs } from './jobs.ts'
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

if (config.WORKER_ROLE === 'local') {
  // The owner's PC: reads Musinsa through Aside and hands the rest to the cloud worker. It never
  // migrates (the cloud worker owns the schema), polls Telegram or touches Threads.
  const [row] = await query<{ present: boolean }>(
    "select to_regclass('public.campaigns') is not null as present",
  )
  if (!row?.present) {
    console.error(
      '[worker] role=local: table "campaigns" not found. Start the cloud worker first (it runs the migrations) or run `npm run db:migrate`.',
    )
    await pool.end()
    process.exit(1)
  }
  const boss = createBoss()
  await boss.start()
  await registerLocalCampaignJobs(boss)
  console.log(
    `[worker] started · role=local · musinsa-collect "${config.MUSINSA_COLLECT_CRON}" ${config.TZ_NAME}`,
  )
  onSignals(async () => {
    await boss.stop({ graceful: true })
    await pool.end()
  })
} else {
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
    extend: (bot) => registerCampaignBots(boss, bot),
  })
  await registerJobs(boss, reviewer)
  await registerCampaignJobs(boss)
  reviewer.start()
  // Null when DASHBOARD_PASSWORD is unset.
  const dashboard = await startDashboard()

  console.log(
    `[worker] started · role=cloud · collect "${config.COLLECT_CRON}" ${config.TZ_NAME} · slots ${config.PUBLISH_SLOTS.join(', ')}` +
      ` · gift-collect "${config.GIFT_COLLECT_CRON}"` +
      (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : ''),
  )
  onSignals(async () => {
    await reviewer.stop()
    await dashboard?.close()
    await boss.stop({ graceful: true })
    await pool.end()
  })
}
