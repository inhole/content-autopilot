import { collectMusinsaCampaigns } from './campaigns/collect.ts'
import { fetchGiftTrialList } from './campaigns/gift.ts'
import { runGiftCollect } from './campaigns/jobs.ts'
import { fetchMusinsaList, musinsaTitle } from './campaigns/musinsa.ts'
import { rankCollected as rankCampaigns } from './campaigns/rank.ts'
import { runCampaignReminders } from './campaigns/reminders.ts'
import { generateReviewDraft, requestDraftRegeneration } from './campaigns/review-draft.ts'
import { sendDraft } from './campaigns/review-telegram.ts'
import { loadCampaign } from './campaigns/store.ts'
import { formatCampaignCard, sendCampaignCard } from './campaigns/telegram.ts'
import { sendCampaignMessage } from './campaigns/tg.ts'
import { competition } from './campaigns/types.ts'
import { config, requireValue } from './config.ts'
import { pool, query } from './db/pool.ts'
import { publishChain } from './pipeline/chain.ts'
import { addManualTopic, collectAll } from './pipeline/collect.ts'
import { generatePost, pendingShortlistedTopicIds, SkipTopicError } from './pipeline/generate.ts'
import { collectInsights, loadInsightRows, weeklyReport } from './pipeline/insights.ts'
import { loadParts, retryFailedParts } from './pipeline/parts.ts'
import { approvePost, publishPost, rejectPost } from './pipeline/publish.ts'
import { rankCollected } from './pipeline/rank.ts'
import { pollReplies } from './pipeline/replies.ts'
import { createReviewer, formatReview } from './review/telegram.ts'
import { getThreadsApi, refreshThreadsTokenIfNeeded } from './threads/account.ts'
import { ThreadsClient } from './threads/client.ts'
import {
  authorizeUrl,
  cleanCode,
  exchangeCode,
  lookupTokenOwner,
  writeEnv,
} from './threads/oauth.ts'
import { formatProbe, runProbe } from './threads/probe.ts'

const USAGE = `usage: npm run cli -- <command>

  collect                     fetch RSS feeds into topics
  daily                       collect → rank → generate drafts (no queue)
  add-topic "<title>" [url] [note]  create a draft from a manual topic
  list [status]               list posts (default: all recent)
  show <postId>               print a draft as it appears in review
  review [postId]             (re)send a draft, or all PENDING_REVIEW drafts, to Telegram
  approve <postId>            approve and assign the next publish slot
  reject <postId>             reject a draft
  publish-now <postId>        approve (if needed) and publish immediately
  threads:auth-url            print the Threads authorize URL (needs THREADS_APP_ID)
  threads:token <code|url>    exchange the code for a long-lived token and save it to .env
  threads:fill-user-id        look up the owner of THREADS_ACCESS_TOKEN and save THREADS_USER_ID
  threads:check               verify the Threads token (GET /me)
  threads:probe               read-only check of the API behaviour publishing relies on (.env token)
  threads:refresh             refresh the Threads token if it is close to expiry
  insights                    collect Threads post insights now and print the latest numbers
  report                      print the weekly insights report (same text as Telegram /report)
  replies                     poll new Threads replies now and notify Telegram

  gift:list                   fetch the Kakao gift trial list and print it (writes nothing)
  musinsa:list                fetch the Musinsa preuser list via Aside and print it (writes nothing)
  musinsa:collect             collect the Musinsa list (via Aside), rank new campaigns and send cards
  campaign:collect            collect the gift list, rank new campaigns and send their cards
  campaign:rank               rank COLLECTED campaigns (no Telegram)
  campaign:show <id>          print status, skip reason and the card text
  campaign:card <id>          (re)send the campaign card to Telegram
  campaign:remind             send due campaign reminders now
  review:draft <id> [feedback]  write (or rewrite) the gift review draft and send it`

// The CLI never polls Telegram (that is the worker's job); it only sends review messages.
const reviewer = createReviewer({ onRegenerate: async () => {}, onAddTopic: async () => {} })

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
  const parts = (await loadParts(postId)).map((p) => p.text)
  console.log(`[${post.status}]\n${formatReview(post, { parts, cta: config.THREAD_CTA_TEXT })}\n`)
}

const [command, ...args] = process.argv.slice(2)
const id = () => {
  const n = Number(args[0])
  if (!Number.isInteger(n)) throw new Error('postId is required')
  return n
}

const campaignId = () => {
  const n = Number(args[0])
  if (!Number.isInteger(n)) throw new Error('campaign id is required')
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
      const [title, url, note] = args
      if (!title) throw new Error('title is required')
      const postId = await generatePost(await addManualTopic(title, url, note))
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
      const outcome = await publishPost(postId)
      console.log(outcome)
      // Without a running worker nothing else publishes the follow-ups (or the link on them). This
      // also resumes a chain whose main post is already up, with a fresh budget for FAILED parts.
      if ((await loadParts(postId)).length > 0) {
        await retryFailedParts(postId)
        console.log('chain:', await publishChain(postId))
      }
      break
    }
    case 'threads:auth-url':
      console.log(authorizeUrl(requireValue('THREADS_APP_ID')))
      break
    case 'threads:fill-user-id': {
      const owner = await lookupTokenOwner(requireValue('THREADS_ACCESS_TOKEN'), {
        baseUrl: config.THREADS_API_BASE,
      })
      await writeEnv('.env', { THREADS_USER_ID: owner.id })
      console.log(`saved to .env: THREADS_USER_ID=${owner.id} (@${owner.username})`)
      break
    }
    case 'threads:token': {
      if (!args[0]) throw new Error('code (or the redirected URL) is required')
      const token = await exchangeCode({
        appId: requireValue('THREADS_APP_ID'),
        appSecret: requireValue('THREADS_APP_SECRET'),
        code: cleanCode(args[0]),
      })
      // Written straight to .env so the token never has to be copied around or printed.
      await writeEnv('.env', {
        THREADS_USER_ID: token.userId,
        THREADS_ACCESS_TOKEN: token.accessToken,
      })
      const days = Math.round(token.expiresInSeconds / 86_400)
      console.log(`saved to .env: THREADS_USER_ID=${token.userId}, long-lived token (${days} days)`)
      break
    }
    case 'threads:check':
      console.log(await (await getThreadsApi()).me())
      break
    case 'threads:probe': {
      // Uses the .env token directly and never the DB: probing with a non-publishing account
      // (e.g. the owner's personal one) must not seed it into platform_accounts.
      const api = new ThreadsClient({
        baseUrl: config.THREADS_API_BASE,
        userId: config.THREADS_USER_ID ?? 'me',
        accessToken: requireValue('THREADS_ACCESS_TOKEN'),
      })
      console.log(formatProbe(await runProbe(api)))
      break
    }
    case 'threads:refresh':
      console.log(await refreshThreadsTokenIfNeeded())
      break
    case 'insights': {
      console.log(await collectInsights())
      console.table(
        (await loadInsightRows()).map((r) => ({
          id: r.postId,
          published: r.publishedAt.toISOString().slice(0, 16),
          text: r.text.slice(0, 24),
          ...(r.metrics ?? {}),
        })),
      )
      break
    }
    case 'report':
      console.log(await weeklyReport())
      break
    case 'replies': {
      const fresh = await pollReplies((text) => reviewer.notifyWithId(text))
      console.log(`${fresh.length} new reply(ies)`)
      for (const r of fresh)
        console.log(`- @${r.username ?? '?'} (post #${r.post_id}): ${r.text ?? '-'}`)
      break
    }
    case 'gift:list': {
      const list = await fetchGiftTrialList()
      console.log(
        `${list.items.length} campaign(s) of ${list.totalCount ?? '?'}, ${list.invalid} invalid`,
      )
      console.table(
        list.items.slice(0, 30).map((i) => ({
          id: i.campaignId,
          title: i.campaignTitle.slice(0, 40),
          brand: i.brand?.name ?? '-',
          days: i.remainingDays,
          slots: i.recruitmentCount,
          applicants: i.applicationCount,
        })),
      )
      break
    }
    case 'musinsa:list': {
      const list = await fetchMusinsaList()
      console.log(`${list.items.length} campaign(s), ${list.invalid} invalid`)
      console.table(
        list.items.slice(0, 40).map((i) => ({
          id: i.campaignId,
          title: musinsaTitle(i).slice(0, 40),
          brand: i.brandName ?? '-',
          ends: i.campaignEndDate,
          type: i.contentType ?? '-',
        })),
      )
      break
    }
    case 'musinsa:collect': {
      const collected = await collectMusinsaCampaigns()
      const picked = await rankCampaigns()
      for (const id of picked) await sendCampaignCard(id)
      console.log({ ...collected, created: collected.created.length, picked })
      break
    }
    case 'campaign:collect':
      console.log(await runGiftCollect(sendCampaignCard))
      break
    case 'campaign:rank':
      console.log('shortlisted:', await rankCampaigns())
      break
    case 'campaign:show': {
      const c = await loadCampaign(campaignId())
      if (!c) throw new Error(`campaign ${args[0]} not found`)
      const ratio = competition(c)
      const shown = ratio === null ? '-' : Math.round(ratio)
      console.log(`[${c.status}] skip: ${c.skip_reason ?? '-'} · competition: ${shown}\n`)
      console.log(formatCampaignCard(c, new Date(), config.TZ_NAME))
      break
    }
    case 'campaign:card':
      await sendCampaignCard(campaignId())
      console.log('card sent')
      break
    case 'campaign:remind':
      console.log(`sent ${await runCampaignReminders(sendCampaignMessage)} reminder(s)`)
      break
    case 'review:draft': {
      const id = campaignId()
      const seq = await requestDraftRegeneration(id)
      if (seq === null) throw new Error(`campaign ${id} is not SELECTED or DRAFT_REVIEW`)
      const written = await generateReviewDraft(id, {
        feedback: args.slice(1).join(' ') || undefined,
        seq,
      })
      if (written) await sendDraft(id)
      console.log(
        written ? 'draft written' : 'nothing written (no memo yet, or the campaign moved on)',
      )
      break
    }
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
