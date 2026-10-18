import { type Bot, InlineKeyboard } from 'grammy'
import { localDate } from '../lib/time.ts'
import { ageInDays, type RevivablePost } from './revive.ts'

export const REVIVE_HELP_LINES = ['/revive - 만료된 초안 중 다시 올릴 만한 것 고르기']
export const REVIVE_BOT_COMMANDS = [{ command: 'revive', description: '만료 초안 다시 살리기' }]

export const encodeRevive = (postId: number) => `rv:${postId}`

export function parseRevive(data: string): number | null {
  const m = /^rv:(\d+)$/.exec(data)
  return m ? Number(m[1]) : null
}

const ago = (p: RevivablePost, now: Date, tz: string) => `${ageInDays(p.createdAt, now, tz)}일 전`
const snippet = (title: string) => (title.length > 60 ? `${title.slice(0, 60)}…` : title)

export function formatReviveList(posts: RevivablePost[], now: Date, tz: string): string {
  const evergreen = posts.filter((p) => p.verdict === 'evergreen')
  const stale = posts.filter((p) => p.verdict === 'stale')
  if (!evergreen.length && !stale.length) return '살릴 만한 만료 초안이 없어요'
  const line = (p: RevivablePost) => [
    `#${p.id} (${ago(p, now, tz)}) ${snippet(p.title)}`,
    ...(p.reason ? [`  ${p.reason}`] : []),
  ]
  const lines: string[] = [`♻️ 만료 초안 (${localDate(now, tz)} 기준)`]
  lines.push('', evergreen.length ? '다시 올릴 만한 글' : '다시 올릴 만한 글은 없어요')
  for (const p of evergreen) lines.push(...line(p))
  if (stale.length) {
    lines.push('', '주간 묶음 후보')
    for (const p of stale) lines.push(...line(p))
  }
  return lines.join('\n')
}

/** One "살리기" button per evergreen post. */
export function reviveKeyboard(posts: RevivablePost[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const p of posts) {
    if (p.verdict === 'evergreen') kb.text(`♻️ #${p.id} 살리기`, encodeRevive(p.id)).row()
  }
  return kb
}

/** Registers /revive and the rv:<postId> buttons. Call it from the review bot's `extend` hook. */
export function registerReviveBot(
  bot: Bot,
  deps: { onJudge(): Promise<void>; onRevive(postId: number): Promise<void> },
): void {
  bot.command('revive', async (ctx) => {
    await ctx.reply('♻️ 만료 초안을 살펴보는 중…')
    await deps.onJudge()
  })
  bot.callbackQuery(/^rv:\d+$/, async (ctx) => {
    const data = ctx.callbackQuery.data
    const postId = parseRevive(data)
    if (postId === null) return
    await ctx.answerCallbackQuery()
    // Remove only the pressed button; strip all if that edit fails.
    try {
      const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []
      const kept = rows.filter(
        (row) => !row.some((b) => 'callback_data' in b && b.callback_data === data),
      )
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: kept } })
    } catch {
      await ctx.editMessageReplyMarkup().catch(() => {})
    }
    await ctx.reply(`♻️ #${postId} 다시 쓰는 중…`)
    await deps.onRevive(postId)
  })
}
