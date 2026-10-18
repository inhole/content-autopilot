import {
  createCampaignQueues,
  registerCampaignBots,
  registerCampaignJobs,
} from './campaigns/jobs.ts'
import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool, query } from './db/pool.ts'
import { createBoss, enqueueGenerate, enqueueRegeneration, registerJobs } from './jobs.ts'
import { createReviewer } from './review/telegram.ts'

const role = config.WORKER_ROLE

if (role === 'cloud') {
  const applied = await migrate()
  if (applied.length) console.log(`[db] applied ${applied.join(', ')}`)
} else {
  // Only the cloud worker migrates, so a fresh database must be set up from there first.
  const [row] = await query<{ t: string | null }>("select to_regclass('public.campaigns') as t")
  if (!row?.t) {
    console.error(
      '[worker] campaigns table is missing: start the cloud worker (or run `npm run db:migrate`) first',
    )
    await pool.end()
    process.exit(1)
  }
}

const boss = createBoss()
await boss.start()

// The local worker never polls Telegram (a second poller gets 409 Conflicts); it only sends.
let reviewer: ReturnType<typeof createReviewer> | undefined
if (role === 'cloud') {
  reviewer = createReviewer({
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
}
await createCampaignQueues(boss)
await registerCampaignJobs(boss, role)
reviewer?.start()

if (role === 'cloud') {
  console.log(
    `[worker] started (cloud) · collect "${config.COLLECT_CRON}" ${config.TZ_NAME} · slots ${config.PUBLISH_SLOTS.join(', ')}` +
      (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : ''),
  )
} else {
  console.log(
    `[worker] started (local) · rooms ${config.KAKAO_ROOMS.join(', ') || '(none)'} · kakao-collect "${config.KAKAO_COLLECT_CRON}" ${config.TZ_NAME}` +
      (config.ASIDE_DRY_RUN ? ' · ASIDE DRY-RUN' : ''),
  )
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[worker] ${signal}, stopping`)
  await reviewer?.stop()
  await boss.stop({ graceful: true })
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
