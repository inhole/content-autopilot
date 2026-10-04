import { Bot, InlineKeyboard } from 'grammy'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { approvePost, rejectPost } from '../pipeline/publish.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'

const EDIT_PREFIX = /^수정\s*[:：]\s*/

type ReviewPost = {
  id: number
  topic_id: number
  text: string
  angle: string | null
  source_url: string | null
  caveats: string[] | null
  score: number | null
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

const keyboard = (postId: number) =>
  new InlineKeyboard()
    .text('✅ 승인', `approve:${postId}`)
    .text('🔁 재생성', `regen:${postId}`)
    .text('🗑 폐기', `reject:${postId}`)

/**
 * Telegram review bot. Without TELEGRAM_BOT_TOKEN it falls back to logging, and drafts can be
 * approved from the CLI instead.
 */
export function createReviewer(opts: {
  onRegenerate: (topicId: number, feedback?: string) => Promise<void>
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

  // Until TELEGRAM_CHAT_ID is set the bot only tells you your chat id.
  bot.command('start', (ctx) =>
    ctx.reply(`chat id: ${ctx.chat.id}\n.env의 TELEGRAM_CHAT_ID에 넣어주세요.`),
  )
  bot.use(async (ctx, next) => {
    if (chatId && ctx.chat?.id === chatId) await next()
  })

  bot.on('callback_query:data', async (ctx) => {
    const [action, idText] = ctx.callbackQuery.data.split(':')
    const postId = Number(idText)
    const [post] = await query<{ topic_id: number }>('select topic_id from posts where id = $1', [
      postId,
    ])
    if (!post) {
      await ctx.answerCallbackQuery({ text: '글을 찾을 수 없어요' })
      return
    }
    try {
      if (action === 'approve') {
        const at = await approvePost(postId)
        await ctx.editMessageReplyMarkup()
        await ctx.reply(`✅ #${postId} 승인 · ${fmtTime(at)} 발행 예정`)
      } else if (action === 'reject') {
        await rejectPost(postId)
        await ctx.editMessageReplyMarkup()
        await ctx.reply(`🗑 #${postId} 폐기`)
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
      await query('update posts set text = $2, updated_at = now() where id = $1', [post.id, text])
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
        `select p.id, p.topic_id, p.text, p.angle, p.source_url, t.score,
                array(select jsonb_array_elements_text(p.generation->'caveats')) as caveats
         from posts p join topics t on t.id = p.topic_id where p.id = $1`,
        [postId],
      )
      if (!post) throw new Error(`post ${postId} not found`)
      const msg = await bot.api.sendMessage(chatId, formatReview(post), {
        reply_markup: keyboard(postId),
        link_preview_options: { is_disabled: true },
      })
      await query(
        'update posts set review_chat_id = $2, review_message_id = $3, updated_at = now() where id = $1',
        [postId, chatId, msg.message_id],
      )
    },
    async notify(text) {
      if (chatId) await bot.api.sendMessage(chatId, text)
      else console.log(`[notify] ${text}`)
    },
    start() {
      void bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) })
    },
    async stop() {
      await bot.stop()
    },
  }
  return reviewer
}
