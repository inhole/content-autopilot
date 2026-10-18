import type { Bot } from 'grammy'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import {
  addPhoto,
  approveDraft,
  charCount,
  findMissingKeywords,
  generateBlogDraft,
  markPosted,
  markReceived,
  parseBlogUrl,
  replaceDraft,
  requestDraftRegeneration,
  retryDraftSave,
  saveMemo,
  startIntake,
} from './blog.ts'
import type { SaveOutcome } from './blog-save.ts'
import { parseCampaignCallback } from './callbacks.ts'
import { loadCampaign } from './store.ts'
import { clearButtons, sendCampaignMessage } from './tg.ts'
import type { Campaign } from './types.ts'

export const INTAKE_TEXT =
  '이 메시지에 답장으로 사진(여러 장 가능)과 사용 메모를 보내주세요. 메모를 보내면 초안을 만들어요.'

export const BLOG_HELP_LINES = [
  '/posted <id> <블로그 주소> — 발행한 후기를 완료 처리',
  '(블로그 임시저장 완료 메시지에 주소로 답장해도 돼요)',
]

export const BLOG_BOT_COMMANDS = [
  { command: 'posted', description: '발행한 블로그 후기 주소 등록 (/posted <id> <url>)' },
]

const CARD_BODY_LIMIT = 3300

/** What the owner can type as a reply to a draft card. */
export type DraftReply =
  | { kind: 'body'; text: string }
  | { kind: 'title'; text: string }
  | { kind: 'feedback'; text: string }

export function parseDraftReply(input: string): DraftReply {
  const text = input.trim()
  const m = text.match(/^(수정|제목)\s*[:：]\s*([\s\S]+)$/)
  if (m?.[2]?.trim()) {
    return { kind: m[1] === '제목' ? 'title' : 'body', text: m[2].trim() }
  }
  return { kind: 'feedback', text }
}

/** Finds the first Naver blog URL inside free text. */
export function extractBlogUrl(text: string): string | null {
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const url = parseBlogUrl(m[0].replace(/[)\].,>]+$/, ''))
    if (url) return url
  }
  return null
}

export function formatDraftCard(
  c: Pick<Campaign, 'id' | 'title' | 'draft_title' | 'draft_body'>,
  photoCount: number,
  missingKeywords: string[],
): string {
  const body = c.draft_body ?? ''
  const shown =
    body.length > CARD_BODY_LIMIT ? `${body.slice(0, CARD_BODY_LIMIT)}\n…(이하 생략)` : body
  const lines = [
    `📝 블로그 초안 #${c.id}${c.title ? ` — ${c.title}` : ''}`,
    '',
    `제목: ${c.draft_title ?? ''}`,
    '',
    shown,
    '',
    `글자수 ${charCount(body).toLocaleString('en-US')}자 · 사진 ${photoCount}장`,
  ]
  if (missingKeywords.length) {
    lines.push(`⚠️ 빠진 필수 키워드: ${missingKeywords.join(', ')}`)
  }
  lines.push(
    '',
    '이 메시지에 답장: "수정: 본문"으로 본문 교체, "제목: 새 제목"으로 제목 교체, 그 외는 수정 요청으로 재생성',
  )
  return lines.join('\n')
}

/**
 * Sends the DRAFT_REVIEW card and registers it as the current one only if the revision it shows
 * is still current. The previous card's buttons are removed.
 */
export async function sendDraftCard(campaignId: number): Promise<number | null> {
  const c = await loadCampaign(campaignId)
  if (c?.status !== 'DRAFT_REVIEW' || !c.draft_body) return null
  const [{ n } = { n: 0 }] = await query<{ n: number }>(
    'select count(*)::int as n from campaign_photos where campaign_id = $1',
    [campaignId],
  )
  const keywords = c.detail?.keywords.length ? c.detail.keywords : c.keywords
  const text = formatDraftCard(
    c,
    n,
    findMissingKeywords(`${c.draft_title ?? ''}\n${c.draft_body}`, keywords),
  )
  const messageId = await sendCampaignMessage(text, [
    {
      text: '✅ 승인 (임시저장)',
      callback: { ns: 'blog', action: 'ok', campaignId, revision: c.revision },
    },
    {
      text: '🔁 재생성',
      callback: { ns: 'blog', action: 'regen', campaignId, revision: c.revision },
    },
  ])
  const chatId = config.TELEGRAM_CHAT_ID
  if (messageId === null || chatId === undefined) return messageId
  const prev = { chat: c.review_chat_id, message: c.review_message_id }
  const rows = await query(
    `update campaigns set review_chat_id = $2, review_message_id = $3, review_revision = $4
     where id = $1 and status = 'DRAFT_REVIEW' and revision = $4 returning id`,
    [campaignId, chatId, messageId, c.revision],
  )
  if (rows.length === 0) {
    // The draft changed while sending; the newer card owns the buttons.
    await clearButtons(chatId, messageId)
    return null
  }
  if (prev.chat != null && prev.message != null && prev.message !== messageId) {
    await clearButtons(prev.chat, prev.message)
  }
  return messageId
}

/** Tells the owner how the Naver temp save ended. Retried/skipped outcomes send nothing. */
export async function sendSaveResult(campaignId: number, outcome: SaveOutcome): Promise<void> {
  const c = await loadCampaign(campaignId)
  if (!c) return
  const name = `#${c.id}${c.title ? ` ${c.title}` : ''}`
  if (outcome.kind === 'saved') {
    const messageId = await sendCampaignMessage(
      [
        `💾 ${name} 네이버 블로그에 임시저장했어요.`,
        '블로그 글쓰기의 임시저장 목록에서 확인하고 직접 발행해주세요.',
        `발행 후 이 메시지에 블로그 주소로 답장하거나 /posted ${c.id} <주소> 를 보내면 완료 처리해요.`,
      ].join('\n'),
    )
    if (messageId !== null && config.TELEGRAM_CHAT_ID !== undefined) {
      await query(
        `update campaigns set review_chat_id = $2, review_message_id = $3, review_revision = revision
         where id = $1 and status = 'DRAFT_SAVED'`,
        [campaignId, config.TELEGRAM_CHAT_ID, messageId],
      )
    }
    return
  }
  if (outcome.kind === 'failed' || outcome.kind === 'dry-run') {
    await sendCampaignMessage(
      `❌ ${name} 임시저장하지 못했어요: ${outcome.error ?? '알 수 없는 오류'}`,
      [
        {
          text: '🔁 다시 저장',
          callback: { ns: 'blog', action: 'retry', campaignId, revision: 0 },
        },
      ],
    )
  }
}

/**
 * Generates (or regenerates) the draft for a campaign and sends the card. A regeneration of a
 * draft under review takes a regen_seq first so only the latest request's result is kept.
 */
export async function handleDraftRequest(campaignId: number, feedback?: string): Promise<void> {
  const seq = await requestDraftRegeneration(campaignId)
  const written = await generateBlogDraft(campaignId, {
    feedback,
    ...(seq !== null ? { seq } : {}),
  })
  if (written) await sendDraftCard(campaignId)
}

export type BlogBotDeps = {
  onDraftRequested(id: number, feedback?: string): Promise<void>
  onDraftApproved(id: number): Promise<void>
}

async function currentCard(
  cb: { campaignId: number; revision: number },
  messageId: number | undefined,
): Promise<Campaign | null> {
  const c = await loadCampaign(cb.campaignId)
  if (c?.status !== 'DRAFT_REVIEW') return null
  if (messageId === undefined || c.review_message_id !== messageId) return null
  if (c.review_revision !== c.revision || cb.revision !== c.revision) return null
  return c
}

/** Registers the blog-review handlers. Call from the `extend` hook of the review bot. */
export function registerBlogBot(bot: Bot, deps: BlogBotDeps): void {
  // Commands first: the message:text handler below passes them on, but a command handler must
  // see them before any generic text handler ends the chain.
  bot.command('posted', async (ctx) => {
    const [idText, url] = ctx.match.trim().split(/\s+/)
    const id = Number(idText?.replace(/^#/, ''))
    if (!Number.isInteger(id) || !url) {
      await ctx.reply('사용법: /posted <id> <블로그 주소>')
      return
    }
    try {
      const ok = await markPosted(id, url)
      await ctx.reply(
        ok
          ? `✅ #${id} 후기 발행을 기록했어요.`
          : `#${id}는 임시저장 완료 상태가 아니라서 처리하지 못했어요.`,
      )
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`)
    }
  })

  bot.callbackQuery(/^blog:/, async (ctx) => {
    const cb = parseCampaignCallback(ctx.callbackQuery.data)
    if (cb?.ns !== 'blog') {
      await ctx.answerCallbackQuery()
      return
    }
    const messageId = ctx.callbackQuery.message?.message_id
    try {
      switch (cb.action) {
        case 'received': {
          const ok = await markReceived(cb.campaignId)
          await ctx.answerCallbackQuery({ text: ok ? '📦 수령으로 기록했어요' : '이미 처리됐어요' })
          return
        }
        case 'draft': {
          await markReceived(cb.campaignId)
          const c = await loadCampaign(cb.campaignId)
          if (c?.status !== 'RECEIVED') {
            await ctx.answerCallbackQuery({ text: '초안을 시작할 수 없는 상태예요' })
            return
          }
          const msg = await ctx.reply(INTAKE_TEXT)
          await startIntake(cb.campaignId, msg.message_id)
          await ctx.answerCallbackQuery()
          return
        }
        case 'ok': {
          const c = await currentCard(cb, messageId)
          if (!c || !(await approveDraft(c.id, c.revision))) {
            await ctx.answerCallbackQuery({ text: '지난 초안이에요. 최신 카드를 사용해주세요.' })
            return
          }
          if (c.review_chat_id != null && messageId !== undefined) {
            await clearButtons(c.review_chat_id, messageId)
          }
          await ctx.answerCallbackQuery({ text: '✅ 승인했어요' })
          await ctx.reply(`💾 #${c.id} 네이버 임시저장을 시작해요. 발행은 직접 해주세요.`)
          await deps.onDraftApproved(c.id)
          return
        }
        case 'regen': {
          const c = await currentCard(cb, messageId)
          if (!c) {
            await ctx.answerCallbackQuery({ text: '지난 초안이에요. 최신 카드를 사용해주세요.' })
            return
          }
          await ctx.answerCallbackQuery({ text: '🔁 재생성 중…' })
          await deps.onDraftRequested(c.id)
          return
        }
        case 'retry': {
          const ok = await retryDraftSave(cb.campaignId)
          await ctx.answerCallbackQuery({ text: ok ? '🔁 다시 저장해요' : '이미 처리됐어요' })
          if (ok) await deps.onDraftApproved(cb.campaignId)
          return
        }
      }
      await ctx.answerCallbackQuery()
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 180) })
    }
  })

  bot.on('message:photo', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id
    if (replyTo === undefined) return next()
    const [row] = await query<{ id: number }>(
      'select id from campaigns where intake_message_id = $1',
      [replyTo],
    )
    if (!row) return next()
    const largest = ctx.message.photo.at(-1)
    if (!largest) return
    try {
      const added = await addPhoto(row.id, largest.file_id, largest.file_unique_id)
      // A media group is several messages; answering each would spam the chat.
      if (!ctx.message.media_group_id) {
        const [{ n } = { n: 0 }] = await query<{ n: number }>(
          'select count(*)::int as n from campaign_photos where campaign_id = $1',
          [row.id],
        )
        await ctx.reply(added ? `📷 사진 ${n}장 저장했어요.` : '이미 받은 사진이에요.')
      }
    } catch (err) {
      await ctx.reply(`❌ 사진을 저장하지 못했어요: ${(err as Error).message}`)
    }
  })

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text
    const replyTo = ctx.message.reply_to_message?.message_id
    if (text.startsWith('/') || replyTo === undefined) return next()

    const [intake] = await query<{ id: number }>(
      'select id from campaigns where intake_message_id = $1',
      [replyTo],
    )
    if (intake) {
      if (!(await saveMemo(intake.id, text))) {
        await ctx.reply('지금은 메모를 받을 수 없는 상태예요.')
        return
      }
      await ctx.reply(`📝 #${intake.id} 메모를 받았어요. 초안을 만드는 중…`)
      await deps.onDraftRequested(intake.id)
      return
    }

    const [card] = await query<{ id: number; status: Campaign['status'] }>(
      'select id, status from campaigns where review_message_id = $1',
      [replyTo],
    )
    if (!card) return next()

    if (card.status === 'DRAFT_SAVED') {
      const url = extractBlogUrl(text)
      if (!url) {
        await ctx.reply('블로그 주소(https://blog.naver.com/…)를 답장으로 보내주세요.')
        return
      }
      const ok = await markPosted(card.id, url)
      await ctx.reply(ok ? `✅ #${card.id} 후기 발행을 기록했어요.` : '이미 처리됐어요.')
      return
    }
    if (card.status !== 'DRAFT_REVIEW') return next()

    const parsed = parseDraftReply(text)
    if (parsed.kind === 'feedback') {
      await ctx.reply(`🔁 #${card.id} 피드백 반영해서 재생성 중…`)
      await deps.onDraftRequested(card.id, parsed.text)
      return
    }
    const ok = await replaceDraft(
      card.id,
      replyTo,
      parsed.kind === 'title' ? { title: parsed.text } : { body: parsed.text },
    )
    if (!ok) {
      await ctx.reply('지난 초안이에요. 최신 카드에 답장해주세요.')
      return
    }
    await sendDraftCard(card.id)
  })
}
