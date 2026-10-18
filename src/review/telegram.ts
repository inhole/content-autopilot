import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import { REVIEW_HELP_LINES } from '../campaigns/review-telegram.ts'
import { CAMPAIGN_BOT_COMMANDS, CAMPAIGN_HELP_LINES } from '../campaigns/telegram.ts'
import { config } from '../config.ts'
import { query, transaction } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'
import { fetchArticle } from '../pipeline/article.ts'
import { addManualTopic } from '../pipeline/collect.ts'
import { weeklyReport } from '../pipeline/insights.ts'
import {
  ctaSuffix,
  FIRST_FOLLOWUP_IDX,
  lastFollowupLimit,
  loadParts,
  replaceParts,
  retryFailedParts,
} from '../pipeline/parts.ts'
import { approvePost, publishNow, rejectPost, unschedulePost } from '../pipeline/publish.ts'
import { answerReply } from '../pipeline/replies.ts'
import { formatStatus, loadStatus } from '../pipeline/status.ts'
import { isRejectReason, REJECT_REASONS, type RejectReason } from '../pipeline/style.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'

// `수정:` / `수정1:` edit the main text, `수정2:` / `수정3:` a follow-up; `삭제2` removes one.
const EDIT_REPLY = /^수정\s*(\d*)\s*[:：]\s*/
const DELETE_REPLY = /^삭제\s*(\d+)\s*$/
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

export const HELP_TEXT = [
  '📖 사용법',
  '/status — 현재 현황',
  '/add <url> [의견] — 기사 URL로 초안 만들기',
  '/report — 주간 성과 리포트',
  '/help — 이 도움말',
  '',
  '검수 메시지에 답장하기',
  '- "수정: <새 본문>" → 본문을 그대로 교체',
  '- "수정2: <새 내용>" → 연결 글의 2번째 조각을 그대로 교체 (3번째는 "수정3:")',
  '- "삭제2" → 연결 글의 2번째 조각을 지움 (뒤 조각은 번호가 당겨져요, 본 글은 지울 수 없어요)',
  '- 그 외 답장 → 피드백으로 보고 재생성',
  '',
  '💬 Threads 답글 알림에 답장하기',
  '- 답장한 내용이 그대로 Threads 답글로 달려요 (답글당 1회)',
  '',
  ...CAMPAIGN_HELP_LINES,
  '',
  ...REVIEW_HELP_LINES,
].join('\n')

const BOT_COMMANDS = [
  { command: 'status', description: '현재 현황 보기' },
  { command: 'add', description: '기사 URL로 초안 만들기: /add <url> [의견]' },
  { command: 'help', description: '사용법 보기' },
  { command: 'report', description: '주간 성과 리포트 보기' },
  ...CAMPAIGN_BOT_COMMANDS,
]

type ScheduleAction = 'unsched' | 'pubnow'

/**
 * Callback data for the buttons under an approval confirmation, e.g. `unsched:42:1760000000`.
 * The epoch seconds bind the button to the exact slot it was created for; the string stays far
 * below Telegram's 64-byte limit.
 */
export function encodeScheduleAction(action: ScheduleAction, postId: number, at: Date): string {
  return `${action}:${postId}:${Math.floor(at.getTime() / 1000)}`
}

export function parseScheduleAction(
  data: string,
): { action: ScheduleAction; postId: number; scheduledAt: Date } | null {
  const m = /^(unsched|pubnow):(\d+):(\d+)$/.exec(data)
  if (!m) return null
  return {
    action: m[1] as ScheduleAction,
    postId: Number(m[2]),
    scheduledAt: new Date(Number(m[3]) * 1000),
  }
}

/** Callback data of the button under a chain failure alert, e.g. `chainretry:42`. */
export const encodeChainRetry = (postId: number) => `chainretry:${postId}`

export function parseChainRetry(data: string): number | null {
  const m = /^chainretry:(\d+)$/.exec(data)
  return m ? Number(m[1]) : null
}

const scheduleKeyboard = (postId: number, at: Date) =>
  new InlineKeyboard()
    .text('⏪ 예약 취소', encodeScheduleAction('unsched', postId, at))
    .text('🚀 지금 발행', encodeScheduleAction('pubnow', postId, at))

export type Reviewer = {
  sendForReview(postId: number): Promise<void>
  /** Best effort: removes the buttons of these posts' review messages (e.g. after expiry). */
  retireReviewMessages(postIds: number[]): Promise<void>
  notify(text: string): Promise<void>
  start(): void
  stop(): Promise<void>
  /** Sends text to the owner chat and returns the Telegram message id (null without Telegram). */
  notifyWithId(text: string): Promise<number | null>
  /**
   * Tells the owner that a published post's follow-up replies gave up, with a button that puts
   * the failed parts back in the queue (retryFailedParts).
   */
  notifyChainFailure(postId: number, error: string): Promise<void>
}

export function formatChainFailure(postId: number, error: string): string {
  const short = error.length > 300 ? `${error.slice(0, 300)}…` : error
  return `❌ #${postId} 본 글은 발행됐지만 이어지는 답글 발행이 중단됐어요: ${short}`
}

const fmtTime = (d: Date) =>
  d.toLocaleString('ko-KR', {
    timeZone: config.TZ_NAME,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export type ReviewReply =
  | { kind: 'edit'; idx: number; text: string }
  | { kind: 'delete'; idx: number }
  | { kind: 'feedback' }

/** Classifies the text of a reply to a review message. Part numbers are 1-based like the message. */
export function parseReviewReply(input: string): ReviewReply {
  const edit = EDIT_REPLY.exec(input)
  if (edit) {
    const idx = edit[1] ? Number(edit[1]) : 1
    return { kind: 'edit', idx, text: input.slice(edit[0].length).trim() }
  }
  const del = DELETE_REPLY.exec(input.trim())
  if (del) return { kind: 'delete', idx: Number(del[1]) }
  return { kind: 'feedback' }
}

const len = (text: string) => [...text].length

/**
 * Pure: `parts` are the follow-up texts and `cta` the configured CTA (the caller reads them), so
 * the bot and the CLI render the same text. Without parts it is the single-post format.
 */
export function formatReview(
  p: ReviewPost,
  opts: { parts?: string[]; cta?: string | undefined } = {},
): string {
  const parts = opts.parts ?? []
  const cta = opts.cta || undefined
  const score = p.score != null ? ` · 점수 ${p.score}` : ''
  const lines: string[] = []
  if (parts.length === 0) {
    lines.push(`📝 초안 #${p.id}${score} · ${len(p.text)}/${THREADS_TEXT_LIMIT}자`, '', p.text)
  } else {
    const total = parts.length + 1
    const lastLimit = THREADS_TEXT_LIMIT - len(ctaSuffix(cta ?? ''))
    lines.push(
      `📝 초안 #${p.id}${score} · 연결 글 ${total}개`,
      `[1/${total}] 본 글 (${len(p.text)}/${THREADS_TEXT_LIMIT}자)`,
      p.text,
    )
    parts.forEach((text, i) => {
      const last = i === parts.length - 1
      const extras = last ? [cta ? 'CTA' : '', p.source_url ? '링크' : ''].filter(Boolean) : []
      const limit = last ? lastLimit : THREADS_TEXT_LIMIT
      lines.push(
        `[${i + 2}/${total}] 답글 (${len(text)}/${limit}자)${extras.length ? ` + ${extras.join('·')}` : ''}`,
        text,
      )
    })
    if (cta) lines.push(`— CTA: ${cta}`)
  }
  lines.push('', `관점: ${p.angle ?? '-'}`)
  if (p.caveats?.length) lines.push(`확인 필요: ${p.caveats.join(' / ')}`)
  lines.push(`출처: ${p.source_url ?? '(직접 입력)'}`)
  lines.push(
    '',
    parts.length === 0
      ? '이 메시지에 답장: "수정: <새 본문>"은 그대로 교체, 그 외 답장은 피드백으로 재생성'
      : '이 메시지에 답장: "수정: <새 본문>"·"수정2: <새 내용>"은 그 조각만 교체, "삭제2"는 그 조각 삭제, 그 외 답장은 피드백으로 재생성',
  )
  return lines.join('\n')
}

export type ReviewEdit =
  | { kind: 'edit'; idx: number; text: string }
  | { kind: 'delete'; idx: number }

export type ReviewEditResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'invalid'; message: string }

const STALE_MESSAGE = '이미 처리됐거나 최신 초안이 아니라서 수정하지 못했어요.'

/**
 * Applies an edit/delete from a reply to the review message `replyTo`. The post row is locked
 * with the review guards first, so the parts that get validated and rewritten are the ones the
 * revision bump covers. Validation failures change nothing. On `ok` the caller re-sends the review.
 */
export async function applyReviewEdit(
  postId: number,
  replyTo: number,
  op: ReviewEdit,
): Promise<ReviewEditResult> {
  const invalid = (message: string): ReviewEditResult => ({ ok: false, reason: 'invalid', message })
  return transaction(async (q) => {
    const [post] = await q<{ text: string }>(
      `select text from posts
       where id = $1 and status = 'PENDING_REVIEW' and review_message_id = $2
         and review_revision = revision
       for update`,
      [postId, replyTo],
    )
    if (!post) return { ok: false, reason: 'stale', message: STALE_MESSAGE }
    const followups = (await loadParts(postId, q)).map((p) => p.text)
    const total = followups.length + 1
    const lastLimit = lastFollowupLimit(config.THREAD_CTA_TEXT)
    let text = post.text

    if (op.kind === 'edit') {
      if (op.idx < 1 || op.idx > total) {
        return invalid(`${op.idx}번 조각이 없어요. 이 초안은 ${total}개 조각이에요.`)
      }
      if (!op.text) return invalid('바꿀 내용이 비어 있어요.')
      const limit = op.idx === total && total > 1 ? lastLimit : THREADS_TEXT_LIMIT
      if (len(op.text) > limit) {
        const hint = limit < THREADS_TEXT_LIMIT ? ' (마지막 답글은 CTA 자리를 남겨둬요)' : ''
        return invalid(`${op.idx}번 조각은 ${limit}자를 넘을 수 없어요: ${len(op.text)}자${hint}`)
      }
      if (op.idx === 1) text = op.text
      else followups[op.idx - FIRST_FOLLOWUP_IDX] = op.text
    } else {
      if (op.idx === 1) {
        return invalid('본 글(1번)은 지울 수 없어요. 내용을 바꾸려면 "수정: <새 본문>"을 쓰세요.')
      }
      if (op.idx < FIRST_FOLLOWUP_IDX || op.idx > total) {
        return invalid(`${op.idx}번 조각이 없어요. 이 초안은 ${total}개 조각이에요.`)
      }
      followups.splice(op.idx - FIRST_FOLLOWUP_IDX, 1)
      const newLast = followups[followups.length - 1]
      if (newLast !== undefined && len(newLast) > lastLimit) {
        return invalid(
          `지우면 ${followups.length + 1}번 조각이 마지막 답글이 되는데 ${lastLimit}자를 넘어요 (${len(newLast)}자). 먼저 "수정${followups.length + 1}:"로 줄여주세요.`,
        )
      }
    }

    await q(
      'update posts set text = $2, revision = revision + 1, updated_at = now() where id = $1',
      [postId, text],
    )
    await replaceParts(q, postId, followups)
    return { ok: true }
  })
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
  /**
   * Registers more handlers (the campaign pipeline) after the chat filter and before this bot's
   * own commands and handlers, so they see a reply or button press first and call next() to pass.
   */
  extend?: (bot: Bot) => void
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
      async retireReviewMessages() {},
      async notify(text) {
        console.log(`[notify] ${text}`)
      },
      start() {},
      async stop() {},
      async notifyWithId(text) {
        console.log(`[notify] ${text}`)
        return null
      },
      async notifyChainFailure(postId, error) {
        console.log(`[notify] ${formatChainFailure(postId, error)}`)
      },
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
  opts.extend?.(bot)

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
  bot.command('help', (ctx) => ctx.reply(HELP_TEXT))

  bot.command('report', async (ctx) => {
    try {
      await ctx.reply(await weeklyReport())
    } catch (err) {
      console.error('[telegram] /report failed', err)
      await ctx.reply('리포트를 만들지 못했어요. 로그를 확인해 주세요.')
    }
  })

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
    const chainPostId = parseChainRetry(ctx.callbackQuery.data)
    if (chainPostId !== null) {
      try {
        const reset = await retryFailedParts(chainPostId)
        await ctx.editMessageReplyMarkup().catch(() => {})
        await ctx.answerCallbackQuery(reset ? {} : { text: '다시 시도할 답글이 없어요' })
        if (reset) await ctx.reply(`🔁 #${chainPostId} 답글 ${reset}개를 5분 안에 다시 발행해요`)
      } catch (err) {
        await ctx
          .answerCallbackQuery({ text: (err as Error).message.slice(0, 180) })
          .catch(() => {})
      }
      return
    }
    const sched = parseScheduleAction(ctx.callbackQuery.data)
    if (sched) {
      try {
        // Both helpers only act while the post is still SCHEDULED at the slot the button shows.
        const done =
          sched.action === 'unsched'
            ? await unschedulePost(sched.postId, sched.scheduledAt)
            : await publishNow(sched.postId, sched.scheduledAt)
        await ctx.editMessageReplyMarkup().catch(() => {})
        if (!done) {
          await ctx.answerCallbackQuery({ text: '이미 처리된 예약이에요' })
          return
        }
        await ctx.answerCallbackQuery()
        if (sched.action === 'unsched') {
          await ctx.reply(`⏪ #${sched.postId} 예약 취소 · 검수 대기로 되돌렸어요`)
          await reviewer.sendForReview(sched.postId)
        } else {
          await ctx.reply(`🚀 #${sched.postId} 5분 안에 발행돼요 (다음 발행 확인 주기)`)
        }
      } catch (err) {
        await ctx
          .answerCallbackQuery({ text: (err as Error).message.slice(0, 180) })
          .catch(() => {})
      }
      return
    }
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
        await ctx.reply(`✅ #${postId} 승인 · ${fmtTime(at)} 발행 예정`, {
          reply_markup: scheduleKeyboard(postId, at),
        })
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
    // A reply to a Threads-reply notification is the owner's answer, not review feedback.
    try {
      const answered = await answerReply(replyTo, ctx.message.text)
      if (answered) {
        await ctx.reply(`✅ 답글을 달았어요${answered.permalink ? `\n${answered.permalink}` : ''}`)
        return
      }
    } catch (err) {
      await ctx.reply(`❌ 답글을 달지 못했어요: ${(err as Error).message}`)
      return
    }
    const [post] = await query<{ id: number; topic_id: number }>(
      "select id, topic_id from posts where review_message_id = $1 and status = 'PENDING_REVIEW'",
      [replyTo],
    )
    if (!post) {
      await ctx.reply('검수 대기 중인 초안에 답장해주세요.')
      return
    }
    const input = ctx.message.text
    const parsed = parseReviewReply(input)
    if (parsed.kind === 'feedback') {
      await ctx.reply(`🔁 #${post.id} 피드백 반영해서 재생성 중…`)
      await opts.onRegenerate(post.topic_id, input)
      return
    }
    // Conditioned on status and message id so it cannot race with an approval or a newer draft.
    const result = await applyReviewEdit(post.id, replyTo, parsed)
    if (!result.ok) {
      await ctx.reply(result.message)
      return
    }
    await reviewer.sendForReview(post.id)
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
      const parts = (await loadParts(postId)).map((p) => p.text)
      const msg = await bot.api.sendMessage(
        chatId,
        formatReview(post, { parts, cta: config.THREAD_CTA_TEXT }),
        { reply_markup: keyboard(postId), link_preview_options: { is_disabled: true } },
      )
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
    async retireReviewMessages(postIds) {
      if (postIds.length === 0) return
      const rows = await query<{ review_chat_id: number | null; review_message_id: number | null }>(
        'select review_chat_id, review_message_id from posts where id = any($1::bigint[])',
        [postIds],
      )
      for (const r of rows) {
        if (r.review_chat_id == null || r.review_message_id == null) continue
        // Best effort: the message may be deleted or too old to edit.
        await bot.api.editMessageReplyMarkup(r.review_chat_id, r.review_message_id).catch(() => {})
      }
    },
    async notify(text) {
      if (chatId) await bot.api.sendMessage(chatId, text)
      else console.log(`[notify] ${text}`)
    },
    async notifyWithId(text) {
      if (!chatId) {
        console.log(`[notify] ${text}`)
        return null
      }
      const msg = await bot.api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
      })
      return msg.message_id
    },
    async notifyChainFailure(postId, error) {
      const text = formatChainFailure(postId, error)
      if (!chatId) {
        console.log(`[notify] ${text}`)
        return
      }
      await bot.api.sendMessage(chatId, text, {
        reply_markup: new InlineKeyboard().text('🔁 답글 다시 시도', encodeChainRetry(postId)),
      })
    },
    start() {
      // A polling failure must not take the whole worker (and its jobs) down: retry instead.
      const run = () => {
        polling = bot
          .start({
            onStart: (me) => {
              console.log(`[telegram] @${me.username} polling`)
              // Best effort: the menu is a convenience, and every retry re-registers it harmlessly.
              bot.api
                .setMyCommands(BOT_COMMANDS)
                .catch((err: unknown) => console.warn('[telegram] setMyCommands failed', err))
            },
          })
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
