import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool } from './db/pool.ts'
import { createBoss, enqueueGenerate, registerJobs } from './jobs.ts'
import { createReviewer } from './review/telegram.ts'

const applied = await migrate()
if (applied.length) console.log(`[db] applied ${applied.join(', ')}`)

const boss = createBoss()
await boss.start()

const reviewer = createReviewer({
  onRegenerate: async (topicId, feedback) => {
    await enqueueGenerate(boss, { topicId, feedback })
  },
})
await registerJobs(boss, reviewer)
reviewer.start()

console.log(
  `[worker] started · collect "${config.COLLECT_CRON}" ${config.TZ_NAME} · slots ${config.PUBLISH_SLOTS.join(', ')}` +
    (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : ''),
)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[worker] ${signal}, stopping`)
  await reviewer.stop()
  await boss.stop({ graceful: true })
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
