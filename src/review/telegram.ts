import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'
import { fetchArticle } from '../pipeline/article.ts'
import { addManualTopic } from '../pipeline/collect.ts'
import { approvePost, rejectPost } from '../pipeline/publish.ts'
import { formatStatus, loadStatus } from '../pipeline/status.ts'
import { isRejectReason, REJECT_REASONS, type RejectReason } from '../pipeline/style.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'

const EDIT_PREFIX = /^수정\s*[:：]\s*/
// Another poller (e.g. the previous instance during a Railway redeploy) causes 409 until it exits.
const POLL_RETRY_MS = 30_000

type ReviewPost = {
  id: number
  topic_id: number
  revision: number
  text: string
  angle: string | null
  source_url: string | null
  caveats: string[] | null
  score: number | null
}

const ADD_USAGE = '사용법: /add <url> [한 줄 의견]'

/** Parses the text of `/add <url> [note]`: the first token must be an http(s) URL. */
export function parseAddCommand(
  text: string,
): { url: string; note: string | undefined } | { error: string } {
  const args = text.replace(/^\/add(@\w+)?\s*/i, '').trim()
  const first = args.split(/\s+/)[0] ?? ''
  let url: URL
  try {
    url = new URL(first)
  } catch {
    return { error: ADD_USAGE }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: ADD_USAGE }
  const note = args.slice(first.length).trim()
  return { url: first, note: note || undefined }
}

export type Reviewer = {
  sendForReview(postId: number): Promise<void>
  notify(text: string): Promise<void>
  start(): void
  stop(): Promise<void>
}

const fmtTime = (d: Date) =>
  d.toLocaleString('ko-KR', {
    timeZone: config.TZ_NAME,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function formatReview(p: ReviewPost): string {
  const lines = [
    `📝 초안 #${p.id}${p.score != null ? ` · 점수 ${p.score}` : ''} · ${[...p.text].length}/${THREADS_TEXT_LIMIT}자`,
    '',
    p.text,
    '',
    `관점: ${p.angle ?? '-'}`,
  ]
  if (p.caveats?.length) lines.push(`확인 필요: ${p.caveats.join(' / ')}`)
  lines.push(`출처: ${p.source_url ?? '(직접 입력)'}`)
  lines.push(
    '',
    '이 메시지에 답장: "수정: <새 본문>"은 그대로 교체, 그 외 답장은 피드백으로 재생성',
  )
  return lines.join('\n')
}

/**
 * Buttons only count on the post's current review message, and only while the text is still the
 * revision that message displayed. An edit or regeneration bumps the revision before its new
 * message is sent, and the old message must not approve text the reviewer has not read.
 */
export function isCurrentReviewAction(
  post: {
    status: string
    review_message_id: number | null
    revision: number
    review_revision: number | null
  },
  pressedMessageId: number | undefined,
): boolean {
  return (
    post.status === 'PENDING_REVIEW' &&
    pressedMessageId != null &&
    post.review_message_id === pressedMessageId &&
    post.review_revision === post.revision
  )
}

const keyboard = (postId: number) =>
  new InlineKeyboard()
    .text('✅ 승인', `approve:${postId}`)
    .text('🔁 재생성', `regen:${postId}`)
    .text('🗑 폐기', `reject:${postId}`)

const reasonKeyboard = (postId: number) => {
  const kb = new InlineKeyboard()
  for (const [code, label] of Object.entries(REJECT_REASONS)) kb.text(label, `rr:${postId}:${code}`)
  return kb.row().text('↩ 취소', `rc:${postId}`)
}

/**
 * Callback data is `<action>:<postId>[:<reason>]`. Actions: approve, regen, reject (opens the
 * reason menu), rr (reject with a reason), rc (cancel the menu). Telegram caps data at 64 bytes.
 */
export function parseCallback(
  data: string,
): { action: string; postId: number; reason?: RejectReason } | null {
  const [action, idText, reason] = data.split(':')
  const postId = Number(idText)
  if (!action || !Number.isInteger(postId)) return null
  if (action === 'rr') return reason && isRejectReason(reason) ? { action, postId, reason } : null
  return { action, postId }
}

/**
 * Telegram review bot. Without TELEGRAM_BOT_TOKEN it falls back to logging, and drafts can be
 * approved from the CLI instead.
 */
export function createReviewer(opts: {
  onRegenerate: (topicId: number, feedback?: string) => Promise<void>
  onAddTopic: (topicId: number) => Promise<void>
}): Reviewer {
  const token = config.TELEGRAM_BOT_TOKEN
  const chatId = config.TELEGRAM_CHAT_ID
  if (!token) {
    return {
      async sendForReview(postId) {
        console.log(
          `[review] post ${postId} awaiting review (no Telegram): npm run cli -- show ${postId}`,
        )
      },
      async notify(text) {
        console.log(`[notify] ${text}`)
      },
      start() {},
      async stop() {},
    }
  }

  const bot = new Bot(token)
  let stopped = false
  let retryTimer: NodeJS.Timeout | undefined
  let polling: Promise<unknown> = Promise.resolve()

  // Until TELEGRAM_CHAT_ID is set the bot only tells you your chat id.
  bot.command('start', (ctx) =>
    ctx.reply(`chat id: ${ctx.chat.id}\n.env의 TELEGRAM_CHAT_ID에 넣어주세요.`),
  )
  bot.use(async (ctx, next) => {
    if (chatId && ctx.chat?.id === chatId) await next()
  })

  bot.command('status', async (ctx) => {
    try {
      await ctx.reply(formatStatus(await loadStatus(), config.TZ_NAME))
    } catch (err) {
      console.error('[telegram] /status failed', err)
      await ctx.reply('상태를 불러오지 못했어요. 로그를 확인해 주세요.')
    }
  })

  // Commands must be registered before the message:text handler, which ends the chain for every
  // non-reply text message (commands included).
  bot.command('add', async (ctx) => {
    const parsed = parseAddCommand(ctx.message?.text ?? '')
    if ('error' in parsed) {
      await ctx.reply(parsed.error)
      return
    }
    const { url, note } = parsed
    const [covered] = await query<{ id: number; status: string }>(
      `select p.id, p.status from posts p join topics t on t.id = p.topic_id
       where t.url_hash = $1 order by p.id desc limit 1`,
      [urlHash(url)],
    )
    if (covered) {
      await ctx.reply(`이미 다룬 기사예요 (#${covered.id}, ${covered.status})`)
      return
    }
    // A failed fetch must not block adding the topic; generation fetches the body again anyway.
    const title = await fetchArticle(url)
      .then((a) => a?.title?.trim() || url)
      .catch(() => url)
    const topicId = await addManualTopic(title, url, note)
    await opts.onAddTopic(topicId)
    await ctx.reply(`📥 주제 추가 · 초안 생성 중…${note ? `\n의견: ${note}` : ''}`)
  })

  bot.on('callback_query:data', async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data)
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    const { action, postId, reason } = parsed
    const [post] = await query<{
      topic_id: number
      status: string
      review_message_id: number | null
      revision: number
      review_revision: number | null
    }>(
      'select topic_id, status, review_message_id, revision, review_revision from posts where id = $1',
      [postId],
    )
    if (!post) {
      await ctx.answerCallbackQuery({ text: '글을 찾을 수 없어요' })
      return
    }
    if (!isCurrentReviewAction(post, ctx.callbackQuery.message?.message_id)) {
      await ctx.answerCallbackQuery({
        text: '이전 초안이에요. 최신 검수 메시지에서 눌러주세요',
      })
      await ctx.editMessageReplyMarkup().catch(() => {})
      return
    }
    try {
      if (action === 'approve') {
        // The revision guard closes the gap between this check and the approval.
        const at = await approvePost(postId, { revision: post.revision })
        await ctx.editMessageReplyMarkup()
        await ctx.reply(`✅ #${postId} 승인 · ${fmtTime(at)} 발행 예정`)
      } else if (action === 'reject') {
        // Ask for a reason first; the revision/message checks above guard the next press too.
        await ctx.editMessageReplyMarkup({ reply_markup: reasonKeyboard(postId) })
      } else if (action === 'rc') {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard(postId) })
      } else if (action === 'rr' && reason) {
        await rejectPost(postId, reason)
        await ctx.editMessageReplyMarkup()
        await ctx.reply(`🗑 #${postId} 폐기 (${REJECT_REASONS[reason]})`)
      } else if (action === 'regen') {
        await ctx.editMessageReplyMarkup()
        await ctx.reply(`🔁 #${postId} 재생성 중…`)
        await opts.onRegenerate(post.topic_id)
      }
      await ctx.answerCallbackQuery()
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 180) })
    }
  })

  bot.on('message:text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id
    if (!replyTo) return
    const [post] = await query<{ id: number; topic_id: number }>(
      "select id, topic_id from posts where review_message_id = $1 and status = 'PENDING_REVIEW'",
      [replyTo],
    )
    if (!post) {
      await ctx.reply('검수 대기 중인 초안에 답장해주세요.')
      return
    }
    const input = ctx.message.text
    if (EDIT_PREFIX.test(input)) {
      const text = input.replace(EDIT_PREFIX, '').trim()
      if ([...text].length > THREADS_TEXT_LIMIT) {
        await ctx.reply(`${THREADS_TEXT_LIMIT}자를 넘어요 (${[...text].length}자).`)
        return
      }
      // Conditioned on status and message id so it cannot race with an approval or a newer draft.
      const updated = await query(
        `update posts set text = $2, revision = revision + 1, updated_at = now()
         where id = $1 and status = 'PENDING_REVIEW' and review_message_id = $3
           and review_revision = revision
         returning id`,
        [post.id, text, replyTo],
      )
      if (updated.length === 0) {
        await ctx.reply('이미 처리됐거나 최신 초안이 아니라서 수정하지 못했어요.')
        return
      }
      await reviewer.sendForReview(post.id)
    } else {
      await ctx.reply(`🔁 #${post.id} 피드백 반영해서 재생성 중…`)
      await opts.onRegenerate(post.topic_id, input)
    }
  })

  bot.catch((err) => console.error('[telegram]', err.error))

  const reviewer: Reviewer = {
    async sendForReview(postId) {
      if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set (send /start to the bot)')
      const [post] = await query<ReviewPost>(
        `select p.id, p.topic_id, p.revision, p.text, p.angle, p.source_url, t.score,
                array(select jsonb_array_elements_text(p.generation->'caveats')) as caveats
         from posts p join topics t on t.id = p.topic_id where p.id = $1`,
        [postId],
      )
      if (!post) throw new Error(`post ${postId} not found`)
      const [prev] = await query<{
        review_chat_id: number | null
        review_message_id: number | null
      }>('select review_chat_id, review_message_id from posts where id = $1', [postId])
      const msg = await bot.api.sendMessage(chatId, formatReview(post), {
        reply_markup: keyboard(postId),
        link_preview_options: { is_disabled: true },
      })
      // Register the message only if the text is still the revision it shows. Otherwise a newer
      // revision was written while sending, its own review message is on the way, and this one
      // must not carry buttons.
      const registered = await query(
        `update posts set review_chat_id = $2, review_message_id = $3, review_revision = $4,
           updated_at = now()
         where id = $1 and revision = $4 and status = 'PENDING_REVIEW'
         returning id`,
        [postId, chatId, msg.message_id, post.revision],
      )
      if (registered.length === 0) {
        await bot.api.editMessageReplyMarkup(chatId, msg.message_id).catch(() => {})
        return
      }
      // Best effort: the old message may be deleted or too old to edit.
      if (prev?.review_message_id && prev.review_chat_id != null) {
        await bot.api
          .editMessageReplyMarkup(prev.review_chat_id, prev.review_message_id)
          .catch(() => {})
      }
    },
    async notify(text) {
      if (chatId) await bot.api.sendMessage(chatId, text)
      else console.log(`[notify] ${text}`)
    },
    start() {
      // A polling failure must not take the whole worker (and its jobs) down: retry instead.
      const run = () => {
        polling = bot
          .start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) })
          .catch((err: unknown) => {
            if (stopped) return
            const conflict = err instanceof GrammyError && err.error_code === 409
            console.error(
              `[telegram] polling stopped${conflict ? ' (another instance is polling)' : ''}: ` +
                `${(err as Error).message}; retrying in ${POLL_RETRY_MS / 1000}s`,
            )
            retryTimer = setTimeout(run, POLL_RETRY_MS)
          })
      }
      run()
    },
    async stop() {
      stopped = true
      clearTimeout(retryTimer)
      if (bot.isRunning()) await bot.stop()
      // bot.stop() does not wait for in-flight updates; the polling promise settles after they finish.
      await polling.catch(() => {})
    },
  }
  return reviewer
}
