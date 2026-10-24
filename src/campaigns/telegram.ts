import type { Bot } from 'grammy'
import { config, dashboardEnabled } from '../config.ts'
import { localDate, zonedToUtc } from '../lib/time.ts'
import { type CampaignCallback, parseCampaignCallback } from './callbacks.ts'
import { GIFT_CAMPAIGN_ID_RE } from './gift.ts'
import { musinsaAppUrl } from './musinsa.ts'
import {
  loadActiveCampaigns,
  markApplied,
  markCardSent,
  markResult,
  rejectCampaign,
  setReviewDeadline,
} from './review.ts'
import { loadCampaign } from './store.ts'
import {
  buttonsKeyboard,
  type CampaignButton,
  clearButtons,
  PHOTO_CAPTION_LIMIT,
  sendCampaignMessage,
  sendCampaignPhotoMessage,
} from './tg.ts'
import {
  CAMPAIGN_REJECT_REASONS,
  type Campaign,
  type CampaignRejectReason,
  type CampaignStatus,
  campaignPriceInfo,
  competition,
  isCampaignRejectReason,
  musinsaCategoryLabel,
  musinsaFacts,
  sourceInfo,
} from './types.ts'

const TELEGRAM_TEXT_LIMIT = 4000
const STALE_PRESS_TEXT = '이전 카드예요. 최신 메시지에서 눌러주세요'
const DUE_USAGE =
  '사용법: /due <번호> <날짜>\n예: /due 12 10/30 (지원 형식: 10/30, 10-30, 10.30, 2026-10-30)'

export const CAMPAIGN_HELP_LINES = [
  '🎁 체험단',
  '/camps — 진행 중인 체험단 보기',
  '/due <번호> <날짜> — 리뷰 기한 알려주기 (예: /due 12 10/30)',
  '- 선물하기: 카드의 "📱 선물하기에서 열기"로 폰 카톡에서 신청한 뒤 "✅ 신청함"을 눌러요',
  '- 무신사: 카드의 "📱 무신사 앱에서 열기"로 앱이나 PC에서 신청한 뒤 "✅ 신청함"을 눌러요',
]

export const CAMPAIGN_BOT_COMMANDS = [
  { command: 'camps', description: '진행 중인 체험단 보기' },
  { command: 'due', description: '리뷰 기한 알리기: /due <번호> <날짜>' },
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

/** `10/25(토)` in `tz`. */
export function formatKstDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: tz,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('month')}/${get('day')}(${get('weekday')})`
}

export const formatWon = (n: number) => `${n.toLocaleString('en-US')}원`

const count = (n: number) => n.toLocaleString('en-US')
const clip = (s: string, max: number) =>
  [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s

/** `모집 100명 · 신청 1,234명 (경쟁률 12.3:1)`, leaving out what is unknown. */
export function formatCounts(
  c: Pick<Campaign, 'recruit_count' | 'application_count'>,
): string | null {
  const parts: string[] = []
  if (c.recruit_count != null) parts.push(`모집 ${count(c.recruit_count)}명`)
  if (c.application_count != null) {
    const ratio = competition(c)
    const tail =
      ratio == null
        ? ''
        : ` (경쟁률 ${ratio.toLocaleString('en-US', { maximumFractionDigits: 1 })}:1)`
    parts.push(`신청 ${count(c.application_count)}명${tail}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** `10/27(화)` for a YYYY-MM-DD source date, read as a day in `tz`. */
export const formatIsoDay = (date: string, tz: string) =>
  formatKstDate(zonedToUtc(date, '12:00', tz), tz)

/**
 * Musinsa facts lines: category · list price (→ sale price) · goods count, then the announcement
 * date and the review period. Whatever the source did not give is left out.
 */
export function formatMusinsaFacts(
  c: Pick<Campaign, 'source' | 'detail'>,
  tz: string = config.TZ_NAME,
): string[] {
  const m = musinsaFacts(c)
  if (!m) return []
  const price =
    m.price == null
      ? null
      : m.salePrice != null
        ? `정가 ${formatWon(m.price)} → ${formatWon(m.salePrice)}`
        : `정가 ${formatWon(m.price)}`
  const head = [
    m.category ? musinsaCategoryLabel(m.category) : null,
    price,
    m.goodsCount != null && m.goodsCount > 1 ? `상품 ${m.goodsCount}개` : null,
  ].filter(Boolean)
  const day = (d: string) => formatIsoDay(d, tz)
  const review =
    m.reviewStartDate && m.reviewEndDate
      ? `리뷰 ${day(m.reviewStartDate)}~${day(m.reviewEndDate)}`
      : m.reviewEndDate
        ? `리뷰 ~${day(m.reviewEndDate)}`
        : null
  const dates = [m.winnerDrawDate ? `발표 ${day(m.winnerDrawDate)}` : null, review].filter(Boolean)
  return [head.join(' · '), dates.join(' · ')].filter(Boolean)
}

/** What the owner does with the card, by where the source is applied on. */
const applyInstruction = (source: string) =>
  sourceInfo(source).applyOn === 'pc'
    ? '📱 무신사 앱이나 💻 PC에서 열어 신청한 뒤 ✅ 신청함을 눌러주세요'
    : '📱 폰 카톡에서 열어 신청한 뒤 ✅ 신청함을 눌러주세요'

/** The review card; always fits a 1024-char photo caption. */
export function formatCampaignCard(c: Campaign, now: Date, tz: string): string {
  const lines: string[] = [`🎁 [${sourceInfo(c.source).label}] #${c.id} ${clip(c.title, 200)}`]
  if (c.brand) lines.push(clip(c.brand, 80))
  const counts = formatCounts(c)
  if (counts) lines.push(counts)
  if (c.source === 'musinsa') lines.push(...formatMusinsaFacts(c, tz))
  else {
    const p = campaignPriceInfo(c)
    if (p.price != null) {
      lines.push(
        p.salePrice != null
          ? `정가 ${formatWon(p.price)} → ${formatWon(p.salePrice)}`
          : `정가 ${formatWon(p.price)}`,
      )
    }
  }
  if (c.apply_deadline) {
    const estimate = sourceInfo(c.source).estimatedDeadline ? ' (추정)' : ''
    lines.push(`마감 ${formatDday(daysUntil(c.apply_deadline, now, tz))}${estimate}`)
  }
  if (c.score != null || c.reason) {
    const score = c.score != null ? `⭐ ${c.score}` : ''
    const reason = c.reason ? clip(c.reason, 300) : ''
    lines.push([score, reason].filter(Boolean).join(' · '))
  }
  lines.push('', applyInstruction(c.source))
  return [...lines.join('\n')].slice(0, PHOTO_CAPTION_LIMIT).join('')
}

const cb = (
  c: Pick<Campaign, 'id'>,
  action: CampaignCallback<'camp'>['action'],
  revision: number,
  arg?: string,
): CampaignCallback => ({
  ns: 'camp',
  action,
  campaignId: c.id,
  revision,
  ...(arg ? { arg } : {}),
})

/** Base of the public KakaoTalk hand-off route; null when it cannot work (no dashboard or no public URL). */
export function handoffBaseUrl(): string | null {
  return dashboardEnabled() && config.PUBLIC_BASE_URL ? config.PUBLIC_BASE_URL : null
}

export function campaignCardButtons(
  c: Pick<Campaign, 'id' | 'url' | 'revision'> & { source?: string; external_id?: string },
  handoffBase: string | null = handoffBaseUrl(),
): CampaignButton[] {
  const info = sourceInfo(c.source)
  const open: CampaignButton =
    info.applyOn !== 'pc' && handoffBase && GIFT_CAMPAIGN_ID_RE.test(c.external_id ?? '')
      ? { text: '📱 카카오톡에서 열기', url: `${handoffBase}/go/gift/${c.external_id}` }
      : c.source === 'musinsa' && c.external_id
        ? { text: '📱 무신사 앱에서 열기', url: musinsaAppUrl(c.external_id) }
        : { text: `${info.applyOn === 'pc' ? '💻' : '📱'} ${info.label}에서 열기`, url: c.url }
  return [
    open,
    { text: '✅ 신청함', callback: cb(c, 'applied', c.revision) },
    { text: '🙅 패스', callback: cb(c, 'pass', c.revision) },
  ]
}

export function rejectReasonButtons(c: Pick<Campaign, 'id' | 'revision'>): CampaignButton[] {
  return [
    ...Object.entries(CAMPAIGN_REJECT_REASONS).map(([key, text]) => ({
      text,
      callback: cb(c, 'passr', c.revision, key),
    })),
    { text: '↩️ 취소', callback: cb(c, 'passc', c.revision) },
  ]
}

export const resultButtons = (id: number): CampaignButton[] => [
  { text: '🎉 선정', callback: cb({ id }, 'sel', 0) },
  { text: '😢 미선정', callback: cb({ id }, 'unsel', 0) },
]

/** The follow-up after a selection: the draft button. Shared by the bot and the web console. */
export const draftStartButtons = (id: number): CampaignButton[] => [
  {
    text: '📝 리뷰 초안 쓰기',
    callback: { ns: 'rev', action: 'draft', campaignId: id, revision: 0 },
  },
]

// Messages sent after a transition; the web console sends the same ones (campaigns/actions.ts).
export const passedText = (id: number, reason: CampaignRejectReason) =>
  `🙅 #${id} 패스했어요 (${CAMPAIGN_REJECT_REASONS[reason]})`
export const appliedText = (id: number) => `✅ #${id} 신청 기록 · 결과가 나오면 눌러주세요`
export const selectedText = (id: number) =>
  `🎉 #${id} 선정 축하해요! 리뷰 기한을 /due ${id} 10/30 처럼 알려주세요.`
export const notSelectedText = (id: number) => `😢 #${id} 미선정으로 기록했어요. 다음 기회에!`

const STATUS_LABEL: Partial<Record<CampaignStatus, string>> = {
  APPLIED: '신청함',
  SELECTED: '선정',
  NOT_SELECTED: '미선정',
  DRAFT_REVIEW: '초안 검수',
  POSTED: '리뷰 완료',
}

export function statusLabel(status: CampaignStatus): string {
  return STATUS_LABEL[status] ?? status
}

type Stage = { title: string; statuses: CampaignStatus[]; when: (c: Campaign) => Date | null }

const STAGES: Stage[] = [
  { title: '🆕 신청 대기', statuses: ['PENDING_REVIEW'], when: (c) => c.apply_deadline },
  { title: '📮 결과 대기', statuses: ['APPLIED'], when: (c) => c.apply_deadline },
  { title: '🎉 선정 · 리뷰 작성', statuses: ['SELECTED'], when: (c) => c.review_deadline },
  { title: '📝 초안 검수', statuses: ['DRAFT_REVIEW'], when: (c) => c.review_deadline },
]

/** /camps: active campaigns grouped by stage, with D-n and /due hints. */
export function formatActiveCampaigns(rows: Campaign[], now: Date, tz: string): string {
  if (rows.length === 0) return '진행 중인 체험단이 없어요.'
  const sections: string[] = []
  for (const stage of STAGES) {
    const inStage = rows.filter((c) => stage.statuses.includes(c.status))
    if (inStage.length === 0) continue
    const lines = inStage.map((c) => {
      const at = stage.when(c)
      const dday = at ? ` · ${formatDday(daysUntil(at, now, tz))}` : ''
      const hint =
        c.status === 'SELECTED' && !c.review_deadline ? ` · 기한 모름 (/due ${c.id} 10/30)` : ''
      return `#${c.id} [${sourceInfo(c.source).label}] ${clip(c.title, 60)}${dday}${hint}`
    })
    sections.push(`${stage.title} (${inStage.length})\n${lines.join('\n')}`)
  }
  return sections.join('\n\n').slice(0, TELEGRAM_TEXT_LIMIT)
}

// ---------- /due date parsing ----------

const MONTH_DAY = /^(\d{1,2})[/.-](\d{1,2})$/
const FULL_DATE = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Parses a /due date into the end (23:59) of that day in `tz`. Accepts `M/D`, `M-D`, `M.D`
 * (a day already past this year means next year) and `YYYY-MM-DD` (also `/` or `.`). Anything
 * else, including compact forms like `1030`, is rejected as ambiguous.
 */
export function parseDueDate(input: string, now: Date, tz: string): Date | null {
  const text = input.trim()
  let year: number
  let month: number
  let day: number
  const full = text.match(FULL_DATE)
  if (full) {
    year = Number(full[1])
    month = Number(full[2])
    day = Number(full[3])
    if (!validDate(year, month, day)) return null
  } else {
    const md = text.match(MONTH_DAY)
    if (!md) return null
    month = Number(md[1])
    day = Number(md[2])
    const today = localDate(now, tz)
    year = Number(today.slice(0, 4))
    // Feb 29 may only exist next year.
    if (!validDate(year, month, day) && !validDate(year + 1, month, day)) return null
    if (!validDate(year, month, day) || `${year}-${pad(month)}-${pad(day)}` < today) year += 1
    if (!validDate(year, month, day)) return null
  }
  return zonedToUtc(`${year}-${pad(month)}-${pad(day)}`, '23:59', tz)
}

// ---------- staleness ----------

export type PressVerdict = 'ok' | 'stale' | 'not-found'

/** Actions bound to the card the owner saw (the rest are gated by status alone). */
const REVISION_BOUND = new Set<string>(['applied', 'pass', 'passr', 'passc'])

/**
 * A card button only counts on the campaign's current card, while it is still waiting for review
 * and the card is still the revision the button was created for. Result buttons (sel, unsel) do
 * not depend on what the owner saw; their transitions guard the status.
 */
export function judgeCampaignPress(
  c: Pick<Campaign, 'status' | 'review_message_id' | 'revision' | 'review_revision'> | null,
  press: Pick<CampaignCallback, 'action' | 'revision'>,
  pressedMessageId: number | undefined,
): PressVerdict {
  if (!c) return 'not-found'
  if (!REVISION_BOUND.has(press.action)) return 'ok'
  const current =
    c.status === 'PENDING_REVIEW' &&
    pressedMessageId != null &&
    c.review_message_id === pressedMessageId &&
    c.review_revision === press.revision &&
    c.revision === press.revision
  return current ? 'ok' : 'stale'
}

// ---------- sending ----------

/** Sends (or re-sends) the review card of a campaign and registers it as the current one. */
export async function sendCampaignCard(campaignId: number): Promise<void> {
  const c = await loadCampaign(campaignId)
  if (!c) throw new Error(`campaign ${campaignId} not found`)
  const text = formatCampaignCard(c, new Date(), config.TZ_NAME)
  const buttons = campaignCardButtons(c)
  const messageId = c.image_url
    ? await sendCampaignPhotoMessage(c.image_url, text, buttons)
    : await sendCampaignMessage(text, buttons)
  const chatId = config.TELEGRAM_CHAT_ID
  if (messageId == null || chatId == null) return
  const registered = await markCardSent(c.id, chatId, messageId, c.revision)
  if (!registered) {
    // The card moved on while sending; its own card is on the way.
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

// ---------- bot wiring ----------

const errText = (err: unknown) => (err as Error).message.slice(0, 180)

/** Registers /camps, /due and the camp: buttons. Call before any message:text handler. */
export function registerCampaignBot(bot: Bot): void {
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

  bot.command('due', async (ctx) => {
    const [idText, dateText] = ctx.match.trim().split(/\s+/)
    const id = Number(idText?.replace(/^#/, ''))
    if (!idText || !Number.isInteger(id) || !dateText) {
      await ctx.reply(DUE_USAGE)
      return
    }
    const due = parseDueDate(dateText, new Date(), config.TZ_NAME)
    if (!due) {
      await ctx.reply(`날짜를 읽을 수 없어요: ${dateText}\n${DUE_USAGE}`)
      return
    }
    try {
      if (!(await setReviewDeadline(id, due))) {
        await ctx.reply(
          `#${id} 신청·선정 단계의 체험단이 아니에요. /camps 로 번호를 확인해 주세요.`,
        )
        return
      }
      await ctx.reply(`📅 #${id} 리뷰 기한을 ${formatKstDate(due, config.TZ_NAME)}로 기록했어요.`)
    } catch (err) {
      console.error('[campaign] /due failed', err)
      await ctx.reply(`❌ 기한을 기록하지 못했어요: ${errText(err)}`)
    }
  })

  bot.callbackQuery(/^camp:/, async (ctx) => {
    const press = parseCampaignCallback(ctx.callbackQuery.data)
    if (press?.ns !== 'camp') {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    try {
      const campaign = await loadCampaign(press.campaignId)
      const verdict = judgeCampaignPress(campaign, press, ctx.callbackQuery.message?.message_id)
      if (verdict === 'not-found' || !campaign) {
        await ctx.answerCallbackQuery({ text: '캠페인을 찾을 수 없어요' })
        return
      }
      if (verdict === 'stale') {
        await ctx.answerCallbackQuery({ text: STALE_PRESS_TEXT })
        await ctx.editMessageReplyMarkup().catch(() => {})
        return
      }
      const id = campaign.id
      switch (press.action) {
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
          if (!press.arg || !isCampaignRejectReason(press.arg)) {
            await ctx.answerCallbackQuery({ text: '알 수 없는 사유예요' })
            return
          }
          if (!(await rejectCampaign(id, press.revision, press.arg))) {
            await ctx.answerCallbackQuery({ text: '이미 처리된 카드예요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(passedText(id, press.arg))
          return
        }
        case 'applied': {
          if (!(await markApplied(id, press.revision))) {
            await ctx.answerCallbackQuery({ text: '이미 처리된 카드예요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(appliedText(id), {
            reply_markup: buttonsKeyboard(resultButtons(id)),
          })
          return
        }
        case 'sel': {
          if (!(await markResult(id, true))) {
            await ctx.answerCallbackQuery({ text: '이미 처리됐어요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(selectedText(id), {
            reply_markup: buttonsKeyboard(draftStartButtons(id)),
          })
          return
        }
        case 'unsel': {
          if (!(await markResult(id, false))) {
            await ctx.answerCallbackQuery({ text: '이미 처리됐어요' })
            return
          }
          await ctx.editMessageReplyMarkup().catch(() => {})
          await ctx.answerCallbackQuery()
          await ctx.reply(notSelectedText(id))
          return
        }
      }
    } catch (err) {
      console.error('[campaign] callback failed', err)
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })
}
