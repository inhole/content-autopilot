import { config } from './config.ts'
import { pool, query } from './db/pool.ts'
import { addManualTopic, collectAll } from './pipeline/collect.ts'
import { generatePost, pendingShortlistedTopicIds, SkipTopicError } from './pipeline/generate.ts'
import { approvePost, publishPost, rejectPost } from './pipeline/publish.ts'
import { rankCollected } from './pipeline/rank.ts'
import { createReviewer, formatReview } from './review/telegram.ts'
import { getThreadsApi, refreshThreadsTokenIfNeeded } from './threads/account.ts'

const USAGE = `usage: npm run cli -- <command>

  collect                     fetch RSS feeds into topics
  daily                       collect → rank → generate drafts (no queue)
  add-topic "<title>" [url]   create a draft from a manual topic
  list [status]               list posts (default: all recent)
  show <postId>               print a draft as it appears in review
  review [postId]             (re)send a draft, or all PENDING_REVIEW drafts, to Telegram
  approve <postId>            approve and assign the next publish slot
  reject <postId>             reject a draft
  publish-now <postId>        approve (if needed) and publish immediately
  threads:check               verify the Threads token (GET /me)
  threads:refresh             refresh the Threads token if it is close to expiry`

// The CLI never polls Telegram (that is the worker's job); it only sends review messages.
const reviewer = createReviewer({ onRegenerate: async () => {} })

async function sendReview(postId: number) {
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) await reviewer.sendForReview(postId)
  await show(postId)
}

async function show(postId: number) {
  const [post] = await query<Parameters<typeof formatReview>[0] & { status: string }>(
    `select p.id, p.topic_id, p.text, p.angle, p.source_url, p.status, t.score,
            array(select jsonb_array_elements_text(p.generation->'caveats')) as caveats
     from posts p join topics t on t.id = p.topic_id where p.id = $1`,
    [postId],
  )
  if (!post) throw new Error(`post ${postId} not found`)
  console.log(`[${post.status}]\n${formatReview(post)}\n`)
}

const [command, ...args] = process.argv.slice(2)
const id = () => {
  const n = Number(args[0])
  if (!Number.isInteger(n)) throw new Error('postId is required')
  return n
}

try {
  switch (command) {
    case 'collect':
      console.table(await collectAll())
      break
    case 'daily': {
      console.table(await collectAll())
      await rankCollected()
      // Also picks up SHORTLISTED leftovers from earlier runs. Errors are handled per topic so
      // one bad topic does not block the rest; failed ones stay SHORTLISTED for the next run.
      let failures = 0
      for (const topicId of await pendingShortlistedTopicIds()) {
        try {
          const postId = await generatePost(topicId)
          if (postId !== null) await sendReview(postId)
        } catch (err) {
          if (err instanceof SkipTopicError) {
            console.warn(`skipped: ${err.message}`)
          } else {
            failures++
            console.error(`topic ${topicId} failed: ${(err as Error).message}`)
          }
        }
      }
      if (failures > 0) process.exitCode = 1
      break
    }
    case 'add-topic': {
      const [title, url] = args
      if (!title) throw new Error('title is required')
      const postId = await generatePost(await addManualTopic(title, url))
      if (postId === null) throw new Error('no draft to review (post is rejected or past review)')
      await sendReview(postId)
      break
    }
    case 'list': {
      const rows = await query(
        `select id, status, scheduled_at, published_at, left(text, 40) as text from posts
         where ($1::text is null or status = $1) order by id desc limit 30`,
        [args[0]?.toUpperCase() ?? null],
      )
      console.table(rows)
      break
    }
    case 'show':
      await show(id())
      break
    case 'review': {
      if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set')
      }
      const ids = args[0]
        ? [id()]
        : (
            await query<{ id: number }>(
              "select id from posts where status = 'PENDING_REVIEW' order by id",
            )
          ).map((r) => r.id)
      for (const postId of ids) await reviewer.sendForReview(postId)
      console.log(`sent ${ids.length} draft(s) to Telegram: ${ids.join(', ') || '-'}`)
      break
    }
    case 'approve':
      console.log(`scheduled at ${(await approvePost(id())).toISOString()}`)
      break
    case 'reject':
      await rejectPost(id())
      console.log('rejected')
      break
    case 'publish-now': {
      const postId = id()
      await query(
        `update posts set status = 'SCHEDULED', scheduled_at = now(), attempts = 0, updated_at = now()
         where id = $1 and status in ('PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'FAILED')`,
        [postId],
      )
      console.log(await publishPost(postId))
      break
    }
    case 'threads:check':
      console.log(await (await getThreadsApi()).me())
      break
    case 'threads:refresh':
      console.log(await refreshThreadsTokenIfNeeded())
      break
    default:
      console.log(USAGE)
      process.exitCode = command ? 1 : 0
  }
} catch (err) {
  console.error((err as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
