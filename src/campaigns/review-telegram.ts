import type { Bot } from 'grammy'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { type CampaignCallback, parseCampaignCallback } from './callbacks.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import {
  chars,
  markControlSent,
  markPosted,
  replaceDraft,
  saveMemo,
  startIntake,
} from './review-draft.ts'
import { loadCampaign } from './store.ts'
import { type CampaignButton, clearButtons, sendCampaignMessage } from './tg.ts'
import { type Campaign, sourceInfo } from './types.ts'

const STALE_PRESS_TEXT = '이전 메시지예요. 최신 메시지에서 눌러주세요'

export const REVIEW_HELP_LINES = [
  '📝 리뷰 초안',
  '- 당첨 알림의 "리뷰 초안 쓰기" → 안내 메시지에 사용 메모를 답장하면 초안을 써 줘요',
  '- 초안 안내 메시지에 "수정: <리뷰>" 답장 → 리뷰를 그대로 교체',
  '- 초안 안내 메시지에 그 외 답장 → 피드백으로 보고 다시 작성',
]

export const postedText = (id: number) => `🎉 #${id} 리뷰 완료로 기록했어요`

const errText = (err: unknown) => (err as Error).message.slice(0, 180)

// ---------- formatting ----------

export const intakeText = (c: Pick<Campaign, 'id' | 'title'>) =>
  `#${c.id} ${c.title}\n이 메시지에 답장으로 사용 메모를 보내주세요 (써본 기간, 좋았던 점, 아쉬운 점, 사진에 담은 것 등). 메모를 바탕으로 리뷰 초안을 만들어요.`

/** The control message under the draft; the draft itself is a separate message so it copies clean. */
export function formatDraftControl(
  c: Pick<Campaign, 'id' | 'draft_text'> & { source?: string },
  profile: Pick<CampaignProfile, 'review'>,
): string {
  const { minChars, maxChars } = profile.review
  const n = chars(c.draft_text ?? '')
  const lines = [
    `📝 #${c.id} 리뷰 초안 · ${n}자 (${minChars}~${maxChars}자)`,
    `위 메시지를 길게 눌러 복사해 ${sourceInfo(c.source).reviewPlace}에 붙여 넣으세요.`,
  ]
  if (n < minChars) lines.push(`⚠️ 권장 글자 수보다 ${minChars - n}자 짧아요.`)
  if (n > maxChars) lines.push(`⚠️ 최대 글자 수보다 ${n - maxChars}자 길어요.`)
  return lines.join('\n')
}

export function draftControlButtons(c: Pick<Campaign, 'id' | 'revision'>): CampaignButton[] {
  const cb = (action: 'regen' | 'done'): CampaignCallback => ({
    ns: 'rev',
    action,
    campaignId: c.id,
    revision: c.revision,
  })
  return [
    { text: '🔁 다시 쓰기', callback: cb('regen') },
    { text: '✅ 리뷰 올림', callback: cb('done') },
  ]
}

// ---------- reply / press parsing ----------

export type ReviewReply = { kind: 'edit'; text: string } | { kind: 'feedback'; text: string }

const EDIT_REPLY = /^수정\s*[:：]\s*/

/** `수정: <text>` replaces the draft verbatim; anything else is feedback. */
export function parseReviewReply(input: string): ReviewReply {
  const text = input.trim()
  const m = text.match(EDIT_REPLY)
  return m ? { kind: 'edit', text: text.slice(m[0].length).trim() } : { kind: 'feedback', text }
}

export type ReviewPressVerdict = 'ok' | 'stale' | 'not-found'

/** Regen and done act only on the current control message, at the revision it shows. */
export function judgeReviewPress(
  c: Pick<Campaign, 'status' | 'review_message_id' | 'revision' | 'review_revision'> | null,
  cb: Pick<CampaignCallback, 'revision'>,
  pressedMessageId: number | undefined,
): ReviewPressVerdict {
  if (!c) return 'not-found'
  const current =
    c.status === 'DRAFT_REVIEW' &&
    pressedMessageId != null &&
    c.review_message_id === pressedMessageId &&
    c.review_revision === cb.revision &&
    c.revision === cb.revision
  return current ? 'ok' : 'stale'
}

// ---------- sending ----------

/**
 * Sends the draft alone, then the control message with the buttons, and registers the control
 * message as the current one (only if the draft is still the revision it shows). Returns false
 * when there is nothing to send. The previous control message loses its keyboard.
 */
export async function sendDraft(campaignId: number): Promise<boolean> {
  const c = await loadCampaign(campaignId)
  if (c?.status !== 'DRAFT_REVIEW' || !c.draft_text) return false
  const profile = await loadCampaignProfile()
  await sendCampaignMessage(c.draft_text)
  const messageId = await sendCampaignMessage(
    formatDraftControl(c, profile),
    draftControlButtons(c),
  )
  const chatId = config.TELEGRAM_CHAT_ID
  if (messageId == null || chatId == null) return true
  const registered = await markControlSent(c.id, chatId, messageId, c.revision)
  if (!registered) {
    // The draft changed while sending; a newer control message follows, so this one is dead.
    await clearButtons(chatId, messageId)
    return true
  }
  if (
    c.review_chat_id != null &&
    c.review_message_id != null &&
    c.review_message_id !== messageId
  ) {
    await clearButtons(c.review_chat_id, c.review_message_id)
  }
  return true
}

// ---------- bot wiring ----------

export type ReviewBotDeps = {
  /**
   * Request a draft (re)generation. The implementation registers it with requestDraftRegeneration
   * and runs or enqueues generateReviewDraft(id, { feedback, seq }) followed by sendDraft(id).
   */
  onDraftRequested(id: number, feedback?: string): Promise<void>
}

export function registerReviewBot(bot: Bot, deps: ReviewBotDeps): void {
  bot.callbackQuery(/^rev:/, async (ctx) => {
    const cb = parseCampaignCallback(ctx.callbackQuery.data)
    if (cb?.ns !== 'rev') {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    try {
      const campaign = await loadCampaign(cb.campaignId)
      if (!campaign) {
        await ctx.answerCallbackQuery({ text: '캠페인을 찾을 수 없어요' })
        return
      }
      const id = campaign.id
      if (cb.action === 'draft') {
        if (campaign.status !== 'SELECTED' && campaign.status !== 'DRAFT_REVIEW') {
          await ctx.answerCallbackQuery({ text: '리뷰 초안을 쓸 수 있는 상태가 아니에요' })
          return
        }
        const sent = await ctx.reply(intakeText(campaign))
        await startIntake(id, sent.message_id)
        await ctx.answerCallbackQuery()
        return
      }
      if (judgeReviewPress(campaign, cb, ctx.callbackQuery.message?.message_id) !== 'ok') {
        await ctx.answerCallbackQuery({ text: STALE_PRESS_TEXT })
        await ctx.editMessageReplyMarkup().catch(() => {})
        return
      }
      if (cb.action === 'regen') {
        await ctx.answerCallbackQuery()
        await ctx.reply(`🔁 #${id} 리뷰 초안을 다시 쓰는 중…`)
        await deps.onDraftRequested(id)
        return
      }
      if (cb.action === 'done') {
        if (!(await markPosted(id, cb.revision))) {
          await ctx.answerCallbackQuery({ text: '이미 처리된 메시지예요' })
          return
        }
        await ctx.editMessageReplyMarkup().catch(() => {})
        await ctx.answerCallbackQuery()
        await ctx.reply(postedText(id))
        return
      }
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
    } catch (err) {
      console.error('[campaign] review callback failed', err)
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })

  // Replies to an intake message (memo) or a draft control message. Everything else falls through.
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id
    if (!replyTo || ctx.message.text.startsWith('/')) {
      await next()
      return
    }
    try {
      const [intake] = await query<{ id: number }>(
        `select id from campaigns
         where intake_message_id = $1 and status in ('SELECTED', 'DRAFT_REVIEW')`,
        [replyTo],
      )
      if (intake) {
        if (!(await saveMemo(intake.id, ctx.message.text))) {
          await ctx.reply('메모가 비어 있어요. 써본 느낌을 몇 줄 적어주세요.')
          return
        }
        await ctx.reply(`✍️ #${intake.id} 초안 쓰는 중…`)
        await deps.onDraftRequested(intake.id)
        return
      }
      const [control] = await query<{ id: number }>(
        "select id from campaigns where review_message_id = $1 and status = 'DRAFT_REVIEW'",
        [replyTo],
      )
      if (!control) {
        await next()
        return
      }
      const parsed = parseReviewReply(ctx.message.text)
      if (parsed.kind === 'feedback') {
        await ctx.reply(`🔁 #${control.id} 피드백 반영해서 리뷰를 다시 쓰는 중…`)
        await deps.onDraftRequested(control.id, parsed.text)
        return
      }
      const result = await replaceDraft(control.id, replyTo, parsed.text)
      if (!result.ok) {
        await ctx.reply(result.message)
        return
      }
      await sendDraft(control.id)
    } catch (err) {
      console.error('[campaign] review reply failed', err)
      await ctx.reply(`❌ 처리하지 못했어요: ${errText(err)}`)
    }
  })
}
