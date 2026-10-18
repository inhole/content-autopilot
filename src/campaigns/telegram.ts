import type { Bot } from 'grammy'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import { type CampaignCallback, parseCampaignCallback } from './callbacks.ts'
import { loadCampaignProfile } from './profile.ts'
import {
  approveApply,
  loadActiveCampaigns,
  markAppliedManually,
  markCardSent,
  rejectCampaign,
  replaceApplyMessage,
  retryApply,
} from './review.ts'
import { loadCampaign } from './store.ts'
import {
  buttonsKeyboard,
  type CampaignButton,
  clearButtons,
  sendCampaignMessage,
  sendCampaignPhoto,
} from './tg.ts'
import {
  CAMPAIGN_REJECT_REASONS,
  type Campaign,
  type CampaignRejectReason,
  type CampaignStatus,
  isCampaignRejectReason,
} from './types.ts'

const TELEGRAM_TEXT_LIMIT = 4000
const REVU_CAMPAIGN_URL = /^https?:\/\/(?:www\.)?revu\.net\/campaign\/\d+/i
const CAMP_USAGE = '사용법: /camp <레뷰 캠페인 링크>\n예: https://www.revu.net/campaign/123456'
const STALE_PRESS_TEXT = '이전 카드예요. 최신 메시지에서 눌러주세요'

export const CAMPAIGN_HELP_LINES = [
  '🎁 체험단',
  '/camp <링크> — 레뷰 캠페인 링크를 직접 추가',
  '/camps — 진행 중인 체험단 보기',
  '- 카드에 "수정: <신청 메시지>" 답장 → 신청 메시지를 그대로 교체',
  '- 카드에 그 외 답장 → 피드백으로 보고 신청 메시지를 다시 작성',
]

export const CAMPAIGN_BOT_COMMANDS = [
  { command: 'camp', description: '체험단 링크 추가: /camp <링크>' },
  { command: 'camps', description: '진행 중인 체험단 보기' },
]

// ---------- formatting ----------

/** Whole local calendar days from `now` to `target` in `tz` (negative when past). */
export function daysUntil(target: Date, now: Date, tz: string): number {
  const day = (d: Date) => Date.parse(`${localDate(d, tz)}T00:00:00Z`)
  return Math.round((day(target) - day(now)) / 86_400_000)
}

export function formatDday(days: number): string {
  if (days === 0) return 'D-day'
  return days > 0 ? `D-${days}` : `D+${-days}`
}

/** `10/25(토) 18:00` in `tz`. */
export function formatKstDateTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: tz,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('month')}/${get('day')}(${get('weekday')}) ${get('hour')}:${get('minute')}`
}

const withDday = (d: Date, now: Date, tz: string) =>
  `${formatKstDateTime(d, tz)} (${formatDday(daysUntil(d, now, tz))})`

export const formatWon = (n: number) => `${n.toLocaleString('en-US')}원`

export function formatCampaignCard(c: Campaign, now: Date, tz: string, maxChars?: number): string {
  const lines: string[] = [`🎁 #${c.id} ${c.title ?? c.detail?.title ?? '(제목 없음)'}`]
  const offer = c.detail?.offer
  if (offer) lines.push(`제공: ${offer}`)
  if (c.reward_won != null) lines.push(`제공가치: ${formatWon(c.reward_won)}`)
  if (c.recruit_count != null) lines.push(`모집 인원: ${c.recruit_count}명`)
  if (c.apply_deadline) lines.push(`신청 마감: ${withDday(c.apply_deadline, now, tz)}`)
  if (c.announce_at) lines.push(`발표일: ${formatKstDateTime(c.announce_at, tz)}`)
  if (c.review_deadline) lines.push(`리뷰 마감: ${formatKstDateTime(c.review_deadline, tz)}`)
  if (c.reason) {
    lines.push('', `선별 이유${c.score != null ? ` (점수 ${c.score})` : ''}: ${c.reason}`)
  } else if (c.score != null) {
    lines.push('', `점수: ${c.score}`)
  }
  if (c.keywords.length > 0) lines.push(`필수 키워드: ${c.keywords.join(', ')}`)
  if (c.apply_message) {
    const count = [...c.apply_message].length
    lines.push('', `✍️ 신청 메시지 (${count}${maxChars ? `/${maxChars}` : ''}자)`, c.apply_message)
  }
  lines.push('', c.url)
  return lines.join('\n').slice(0, TELEGRAM_TEXT_LIMIT)
}

export function campaignCardButtons(c: Campaign): CampaignButton[] {
  const cb = (action: 'applied' | 'apply' | 'pass'): CampaignCallback => ({
    ns: 'camp',
    action,
    campaignId: c.id,
    revision: c.revision,
  })
  return [
    { text: '✅ 신청함 (직접)', callback: cb('applied') },
    { text: '🚀 신청 승인 (자동)', callback: cb('apply') },
    { text: '🙅 패스', callback: cb('pass') },
  ]
}

export function rejectReasonButtons(c: Campaign): CampaignButton[] {
  const buttons: CampaignButton[] = (
    Object.entries(CAMPAIGN_REJECT_REASONS) as [CampaignRejectReason, string][]
  ).map(([code, label]) => ({
    text: label,
    callback: { ns: 'camp', action: 'passr', campaignId: c.id, revision: c.revision, arg: code },
  }))
  buttons.push({
    text: '↩️ 취소',
    callback: { ns: 'camp', action: 'passc', campaignId: c.id, revision: c.revision },
  })
  return buttons
}

const STAGES: { title: string; statuses: CampaignStatus[]; when: (c: Campaign) => Date | null }[] =
  [
    {
      title: '📝 신청 검토 대기',
      statuses: ['PENDING_REVIEW'],
      when: (c) => c.apply_deadline,
    },
    {
      title: '🚀 신청 진행 중',
      statuses: ['APPROVED', 'APPLYING', 'APPLY_FAILED'],
      when: (c) => c.apply_deadline,
    },
    { title: '⏳ 발표 대기', statuses: ['APPLIED'], when: (c) => c.announce_at },
    {
      title: '✍️ 리뷰 작성',
      statuses: [
        'SELECTED',
        'RECEIVED',
        'DRAFT_REVIEW',
        'DRAFT_APPROVED',
        'DRAFT_SAVING',
        'DRAFT_SAVED',
        'DRAFT_FAILED',
      ],
      when: (c) => c.review_deadline,
    },
  ]

const STATUS_LABEL: Partial<Record<CampaignStatus, string>> = {
  APPROVED: '신청 대기',
  APPLYING: '신청 중',
  APPLY_FAILED: '신청 실패',
  SELECTED: '선정',
  RECEIVED: '제품 수령',
  DRAFT_REVIEW: '초안 검수',
  DRAFT_APPROVED: '초안 승인',
  DRAFT_SAVING: '임시저장 중',
  DRAFT_SAVED: '임시저장 완료',
  DRAFT_FAILED: '임시저장 실패',
}

export function statusLabel(status: CampaignStatus): string {
  return STATUS_LABEL[status] ?? status
}

export function formatActiveCampaigns(rows: Campaign[], now: Date, tz: string): string {
  if (rows.length === 0) return '진행 중인 체험단이 없어요.'
  const sections: string[] = []
  for (const stage of STAGES) {
    const inStage = rows.filter((c) => stage.statuses.includes(c.status))
    if (inStage.length === 0) continue
    const lines = inStage.map((c) => {
      const at = stage.when(c)
      const label = stage.statuses.length > 1 ? ` [${statusLabel(c.status)}]` : ''
      const dday = at ? ` · ${formatDday(daysUntil(at, now, tz))}` : ''
      return `#${c.id} ${c.title ?? '(제목 없음)'}${label}${dday}`
    })
    sections.push(`${stage.title} (${inStage.length})\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

export function formatApplyResult(
  c: Pick<Campaign, 'id' | 'title' | 'url'>,
  outcome: ApplyOutcome,
): string {
  const name = `#${c.id} ${c.title ?? ''}`.trim()
  switch (outcome.kind) {
    case 'applied':
      return `✅ ${name} 신청을 완료했어요. 발표일을 기다려요.`
    case 'dry-run':
      return `🧪 ${name} 드라이런이라 실제로 신청하지 않았어요 (입력까지만 확인).`
    case 'failed':
      return [
        `❌ ${name} 자동 신청에 실패했어요.`,
        outcome.error ? `사유: ${outcome.error.slice(0, 500)}` : null,
        `직접 신청하려면: ${c.url}`,
      ]
        .filter((l): l is string => l !== null)
        .join('\n')
  }
}

// ---------- staleness and reply parsing ----------

export type PressVerdict = 'ok' | 'stale' | 'not-found'

/**
 * A button only counts on the campaign's current card, while it is still waiting for review and
 * the apply message is still the revision the button was created for. Retry (APPLY_FAILED) is
 * the exception: it does not depend on what the owner saw, and retryApply guards the status.
 */
export function judgeCampaignPress(
  c: Pick<Campaign, 'status' | 'review_message_id' | 'revision' | 'review_revision'> | null,
  cb: Pick<CampaignCallback, 'action' | 'revision'>,
  pressedMessageId: number | undefined,
): PressVerdict {
  if (!c) return 'not-found'
  if (cb.action === 'retry') return 'ok'
  const current =
    c.status === 'PENDING_REVIEW' &&
    pressedMessageId != null &&
    c.review_message_id === pressedMessageId &&
    c.review_revision === cb.revision &&
    c.revision === cb.revision
  return current ? 'ok' : 'stale'
}

export type CampaignReply = { kind: 'edit'; text: string } | { kind: 'feedback'; text: string }

const EDIT_REPLY = /^수정\s*[:：]\s*/

/** `수정: <text>` replaces the apply message verbatim; anything else is feedback. */
export function parseCampaignReply(input: string): CampaignReply {
  const text = input.trim()
  const m = text.match(EDIT_REPLY)
  return m ? { kind: 'edit', text: text.slice(m[0].length).trim() } : { kind: 'feedback', text }
}

// ---------- sending ----------

export type ApplyOutcome = {
  kind: 'applied' | 'dry-run' | 'failed'
  error?: string
  screenshotPath?: string | null
}

async function maxApplyChars(): Promise<number | undefined> {
  try {
    return (await loadCampaignProfile()).applyMessage.maxChars
  } catch {
    return undefined
  }
}

/** Sends (or re-sends) the review card of a campaign and registers it as the current one. */
export async function sendCampaignCard(campaignId: number): Promise<void> {
  const c = await loadCampaign(campaignId)
  if (!c) throw new Error(`campaign ${campaignId} not found`)
  const text = formatCampaignCard(c, new Date(), config.TZ_NAME, await maxApplyChars())
  const messageId = await sendCampaignMessage(text, campaignCardButtons(c))
  const chatId = config.TELEGRAM_CHAT_ID
  if (messageId == null || chatId == null) return
  const registered = await markCardSent(c.id, chatId, messageId, c.revision)
  if (!registered) {
    // The apply message moved on while sending; its own card is on the way.
    await clearButtons(chatId, messageId)
    return
  }
  if (
    c.review_chat_id != null &&
    c.review_message_id != null &&
    c.review_message_id !== messageId
  ) {
    await clearButtons(c.review_chat_id, c.review_message_id)
  }
}

export async function sendApplyResult(campaignId: number, outcome: ApplyOutcome): Promise<void> {
  const c = await loadCampaign(campaignId)
  if (!c) throw new Error(`campaign ${campaignId} not found`)
  const buttons: CampaignButton[] =
    outcome.kind === 'failed'
      ? [
          {
            text: '🔁 다시 신청',
            callback: { ns: 'camp', action: 'retry', campaignId: c.id, revision: 0 },
          },
        ]
      : []
  await sendCampaignMessage(formatApplyResult(c, outcome), buttons)
  if (outcome.screenshotPath) {
    await sendCampaignPhoto(outcome.screenshotPath, `#${c.id} 신청 화면`).catch((err) =>
      console.error('[campaign] screenshot send failed', err),
    )
  }
}

// ---------- bot wiring ----------

export type CampaignBotDeps = {
  onApproveApply(id: number): Promise<void>
  onRewriteApplyMessage(id: number, feedback: string): Promise<void>
  onAddCampaign(id: number): Promise<void>
  addCampaignUrl(url: string): Promise<{ id: number; created: boolean } | null>
}

const errText = (err: unknown) => (err as Error).message.slice(0, 180)

/** Registers /camp, /camps, camp: buttons and replies to campaign cards. */
export function registerCampaignBot(bot: Bot, deps: CampaignBotDeps): void {
  bot.command('camp', async (ctx) => {
    const url = ctx.match.trim().split(/\s+/)[0] ?? ''
    if (!REVU_CAMPAIGN_URL.test(url)) {
      await ctx.reply(CAMP_USAGE)
      return
    }
    try {
      const added = await deps.addCampaignUrl(url)
      if (!added) {
        await ctx.reply(`캠페인 링크로 읽을 수 없어요.\n${CAMP_USAGE}`)
        return
      }
      if (added.created) {
        await ctx.reply(`🔎 #${added.id} 새 캠페인을 추가했어요. 내용을 확인할게요.`)
        await deps.onAddCampaign(added.id)
        return
      }
      const known = await loadCampaign(added.id)
      await ctx.reply(
        `이미 알고 있는 캠페인이에요: #${added.id} ${known?.title ?? ''}`.trim() +
          (known ? ` (${statusLabel(known.status)})` : ''),
      )
    } catch (err) {
      console.error('[campaign] /camp failed', err)
      await ctx.reply(`❌ 캠페인을 추가하지 못했어요: ${errText(err)}`)
    }
  })

  bot.command('camps', async (ctx) => {
    try {
      await ctx.reply(
        formatActiveCampaigns(await loadActiveCampaigns(), new Date(), config.TZ_NAME),
      )
    } catch (err) {
      console.error('[campaign] /camps failed', err)
      await ctx.reply('체험단 목록을 불러오지 못했어요. 로그를 확인해 주세요.')
    }
  })

  bot.callbackQuery(/^camp:/, async (ctx) => {
    const cb = parseCampaignCallback(ctx.callbackQuery.data)
    if (cb?.ns !== 'camp') {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    try {
      const campaign = await loadCampaign(cb.campaignId)
      const verdict = judgeCampaignPress(campaign, cb, ctx.callbackQuery.message?.message_id)
      if (verdict === 'not-found') {
        await ctx.answerCallbackQuery({ text: '캠페인을 찾을 수 없어요' })
        return
      }
      if (verdict === 'stale' || !campaign) {
        await ctx.answerCallbackQuery({ text: STALE_PRESS_TEXT })
        await ctx.editMessageReplyMarkup().catch(() => {})
        return
      }
      const id = campaign.id
      switch (cb.action) {
        case 'pass':
          await ctx.editMessageReplyMarkup({
            reply_markup: buttonsKeyboard(rejectReasonButtons(campaign)),
          })
          await ctx.answerCallbackQuery()
          return
        case 'passc':
          await ctx.editMessageReplyMarkup({
            reply_markup: buttonsKeyboard(campaignCardButtons(campaign)),
          })
          await ctx.answerCallbackQuery()
          return
        case 'passr': {
          if (!cb.arg || !isCampaignRejectReason(cb.arg)) {
            await ctx.answerCallbackQuery({ text: '알 수 없는 사유예요' })
            return
          }
          if (!(await rejectCampaign(id, cb.revision, cb.arg))) {
            await ctx.answerCallbackQuery({ text: '이미 처리된 카드예요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(`🙅 #${id} 패스했어요 (${CAMPAIGN_REJECT_REASONS[cb.arg]})`)
          return
        }
        case 'applied': {
          if (!(await markAppliedManually(id, cb.revision))) {
            await ctx.answerCallbackQuery({ text: '이미 처리된 카드예요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(`✅ #${id} 직접 신청한 것으로 기록했어요. 발표일을 기다려요.`)
          return
        }
        case 'apply': {
          if (!(await approveApply(id, cb.revision))) {
            await ctx.answerCallbackQuery({ text: '이미 처리된 카드예요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(`🚀 #${id} 신청을 시작해요 (로컬 PC)`)
          await deps.onApproveApply(id)
          return
        }
        case 'retry': {
          if (!(await retryApply(id))) {
            await ctx.answerCallbackQuery({ text: '다시 신청할 수 있는 상태가 아니에요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(`🔁 #${id} 다시 신청해요 (로컬 PC)`)
          await deps.onApproveApply(id)
          return
        }
      }
    } catch (err) {
      console.error('[campaign] callback failed', err)
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })

  // Replies to a campaign card. Everything else falls through to the Threads review handlers.
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id
    if (!replyTo || ctx.message.text.startsWith('/')) {
      await next()
      return
    }
    const [row] = await query<{ id: number }>(
      "select id from campaigns where review_message_id = $1 and status = 'PENDING_REVIEW'",
      [replyTo],
    )
    if (!row) {
      await next()
      return
    }
    try {
      const parsed = parseCampaignReply(ctx.message.text)
      if (parsed.kind === 'feedback') {
        await ctx.reply(`🔁 #${row.id} 피드백 반영해서 신청 메시지를 다시 쓰는 중…`)
        await deps.onRewriteApplyMessage(row.id, parsed.text)
        return
      }
      const result = await replaceApplyMessage(row.id, replyTo, parsed.text)
      if (!result.ok) {
        await ctx.reply(result.message)
        return
      }
      await sendCampaignCard(row.id)
    } catch (err) {
      console.error('[campaign] card reply failed', err)
      await ctx.reply(`❌ 처리하지 못했어요: ${errText(err)}`)
    }
  })
}
