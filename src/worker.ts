import { config } from './config.ts'
import { migrate } from './db/migrate.ts'
import { pool } from './db/pool.ts'
import { createBoss, enqueueGenerate, enqueueRegeneration, registerJobs } from './jobs.ts'
import { pingHealthcheck } from './lib/healthcheck.ts'
import { createReviewer } from './review/telegram.ts'

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
})
await registerJobs(boss, reviewer)
reviewer.start()

console.log(
  `[worker] started · collect "${config.COLLECT_CRON}" ${config.TZ_NAME} · slots ${config.PUBLISH_SLOTS.join(', ')}` +
    (config.THREADS_DRY_RUN ? ' · THREADS DRY-RUN' : ''),
)

// Dead man's switch: the worker's own alerts cannot fire once it is dead, so an external
// service alerts when these pings stop. Missed pings from a hung event loop are the point.
const HEARTBEAT_MS = 5 * 60_000
void pingHealthcheck(config.HEALTHCHECK_URL)
const heartbeat = config.HEALTHCHECK_URL
  ? setInterval(() => void pingHealthcheck(config.HEALTHCHECK_URL), HEARTBEAT_MS)
  : undefined

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[worker] ${signal}, stopping`)
  clearInterval(heartbeat)
  await reviewer.stop()
  await boss.stop({ graceful: true })
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
