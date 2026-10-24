import { type Bot, type Context, InlineKeyboard, InputFile } from 'grammy'
import { clearButtons, telegramApi } from '../campaigns/tg.ts'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import {
  type Approval,
  approveVideo,
  reschedulePublication,
  VideoNotReviewableError,
} from './approve.ts'
import { formatScript } from './script.ts'
import { getStorage, type VideoStorage } from './storage.ts'
import {
  applyEdit,
  createVideo,
  type EditOp,
  fullCaption,
  listVideos,
  loadVideo,
  markManualPublished,
  registerReview,
  rejectVideo,
  requestRescript,
  restartVideo,
  scriptOf,
  type VideoRow,
} from './store.ts'
import { PLATFORM_LABELS, type Platform } from './types.ts'

// Telegram review of videos (docs/plans/video.md 3-6): a script message, then the video with the
// buttons. Both are registered for one revision in one UPDATE; buttons and replies only act on
// that revision.

const MESSAGE_LIMIT = 4096
const VIDEO_CAPTION_LIMIT = 1024

export const VIDEO_HELP_LINES = [
  '🎬 숏폼 영상',
  '/video — 영상 후보를 지금 하나 골라 만들기',
  '/video <글 번호> — 그 발행 글로 영상 만들기',
  '/videos — 영상 목록',
  '영상 검수 메시지(원고·영상)에 답장하기',
  '- "수정2: <문장>" → 2번 장면 내레이션 교체, "화면2: <문구>" → 2번 장면 화면 문구 교체 (다시 렌더)',
  '- "제목: …", "캡션: …" → 그대로 교체',
  '- 그 외 답장 → 피드백으로 원고 다시 쓰기',
]

export const VIDEO_BOT_COMMANDS = [
  { command: 'video', description: '영상 만들기: /video [글 번호]' },
  { command: 'videos', description: '영상 목록 보기' },
]

export type VideoAction = 'ok' | 're' | 'rej'

/** `vid:<action>:<videoId>:<revision>`, far below Telegram's 64-byte limit. */
export const encodeVideoAction = (action: VideoAction, videoId: number, revision: number) =>
  `vid:${action}:${videoId}:${revision}`

export function parseVideoAction(
  data: string,
): { action: VideoAction; videoId: number; revision: number } | null {
  const m = /^vid:(ok|re|rej):(\d+):(\d+)$/.exec(data)
  if (!m) return null
  return { action: m[1] as VideoAction, videoId: Number(m[2]), revision: Number(m[3]) }
}

/** Retry button under a publication failure alert. */
export const encodePubRetry = (publicationId: number) => `vpub:retry:${publicationId}`
export function parsePubRetry(data: string): number | null {
  const m = /^vpub:retry:(\d+)$/.exec(data)
  return m ? Number(m[1]) : null
}

/** `📤 직접 올림` under the manual-upload message. */
export const encodeManualDone = (videoId: number) => `vman:${videoId}`
export function parseManualDone(data: string): number | null {
  const m = /^vman:(\d+)$/.exec(data)
  return m ? Number(m[1]) : null
}

const EDIT = /^(수정|화면)\s*(\d+)\s*[:：]\s*/
const FIELD = /^(제목|캡션)\s*[:：]\s*/

export type VideoReply = { kind: 'edit'; op: EditOp } | { kind: 'feedback' }

/** Classifies a reply to a video review message. Scene numbers are 1-based like the message. */
export function parseVideoReply(input: string): VideoReply {
  const edit = EDIT.exec(input)
  if (edit) {
    return {
      kind: 'edit',
      op: {
        kind: edit[1] === '화면' ? 'heading' : 'narration',
        idx: Number(edit[2]),
        text: input.slice(edit[0].length).trim(),
      },
    }
  }
  const field = FIELD.exec(input)
  if (field) {
    return {
      kind: 'edit',
      op: {
        kind: field[1] === '제목' ? 'title' : 'caption',
        text: input.slice(field[0].length).trim(),
      },
    }
  }
  return { kind: 'feedback' }
}

const seconds = (ms: number | null) => (ms == null ? '-' : `${Math.round(ms / 1000)}초`)

const cut = (text: string, max: number) =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`

/** The script message: header, scenes, caption as published, reply help. Pure. */
export function formatVideoReview(v: VideoRow, opts: { silent?: boolean } = {}): string {
  const script = scriptOf(v)
  const lines = [
    `🎬 영상 #${v.id} · ${seconds(v.duration_ms)} · 장면 ${v.scenes?.length ?? 0} · 원본 글 #${v.post_id}`,
  ]
  if (opts.silent) lines.push('🔇 무음(silent) TTS로 만든 미리보기예요')
  lines.push('')
  if (script) lines.push(formatScript(script))
  lines.push('', `출처: ${v.source_url ?? '-'}`)
  lines.push(
    '',
    '답장: "수정N: <문장>"·"화면N: <문구>"은 그 장면만 바꿔 다시 렌더, "제목:"·"캡션:"은 그대로 교체, 그 외는 피드백으로 다시 쓰기',
  )
  return cut(lines.join('\n'), MESSAGE_LIMIT)
}

const reviewKeyboard = (videoId: number, revision: number) =>
  new InlineKeyboard()
    .text('✅ 승인', encodeVideoAction('ok', videoId, revision))
    .text('🔁 다시 만들기', encodeVideoAction('re', videoId, revision))
    .text('🗑 폐기', encodeVideoAction('rej', videoId, revision))

export const formatVideoTime = (d: Date) =>
  d.toLocaleString('ko-KR', {
    timeZone: config.TZ_NAME,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function approvedVideoText(videoId: number, approval: Approval): string {
  if (!approval.at) {
    return `✅ 영상 #${videoId} 승인 · 자동 발행 플랫폼이 없어요. 영상을 저장해서 직접 올리고 아래 버튼을 눌러주세요`
  }
  const where = approval.platforms.map((p) => PLATFORM_LABELS[p]).join(' · ')
  const dry = config.VIDEO_PUBLISH_DRY_RUN ? ' (dry-run)' : ''
  return `✅ 영상 #${videoId} 승인 · ${formatVideoTime(approval.at)} ${where} 발행 예정${dry}`
}

export const publishedText = (
  videoId: number,
  platform: Platform,
  mediaId: string | null,
  permalink: string | null,
) =>
  `🚀 영상 #${videoId} ${PLATFORM_LABELS[platform]} 발행 완료` +
  (permalink ? `\n${permalink}` : mediaId ? '' : '\n(media id를 찾지 못해 성과 수집에서 빠져요)')

export function publicationFailedText(
  videoId: number,
  platform: Platform,
  error: string | null,
  kind: string | null,
): string {
  const hint =
    kind === 'auth'
      ? '\n토큰을 확인해 주세요 (instagram:check / youtube:auth).'
      : kind === 'account'
        ? '\n발행 계정이 승인 때와 달라요. 계정을 확인한 뒤 다시 시도하세요.'
        : ''
  return `❌ 영상 #${videoId} ${PLATFORM_LABELS[platform]} 발행 실패: ${cut(error ?? '-', 300)}${hint}`
}

async function send(text: string, keyboard?: InlineKeyboard): Promise<number | null> {
  const api = telegramApi()
  const chatId = config.TELEGRAM_CHAT_ID
  if (!api || !chatId) {
    console.log(`[video notify] ${text}`)
    return null
  }
  const msg = await api.sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  })
  return msg.message_id
}

export const notifyVideo = (text: string) => send(text).then(() => undefined)

export async function notifyPublicationFailure(f: {
  id: number
  video_id: number
  platform: Platform
  last_error: string | null
  error_kind: string | null
}): Promise<void> {
  const label = f.error_kind === 'session' ? '🔁 확인했어요, 새로 올리기' : '🔁 다시 시도'
  await send(
    publicationFailedText(f.video_id, f.platform, f.last_error, f.error_kind),
    new InlineKeyboard().text(label, encodePubRetry(f.id)),
  )
}

/** Manual upload: the caption to copy, with the `📤 직접 올림` button. */
async function sendManualUpload(v: VideoRow): Promise<void> {
  await send(
    `📋 영상 #${v.id} 캡션 (복사해서 쓰세요)\n\n${fullCaption(v)}`,
    new InlineKeyboard().text('📤 직접 올림', encodeManualDone(v.id)),
  )
}

/**
 * Sends the review for the video's current revision. Registers both messages only if the video
 * is still at that revision; otherwise strips the buttons it just sent (a newer review is coming).
 */
export async function sendVideoReview(
  videoId: number,
  storage: VideoStorage = getStorage(),
): Promise<void> {
  const v = await loadVideo(videoId)
  if (v?.status !== 'PENDING_REVIEW' || !v.video_url) return
  const api = telegramApi()
  const chatId = config.TELEGRAM_CHAT_ID
  const silent = config.VIDEO_TTS_PROVIDER === 'silent'
  const text = formatVideoReview(v, { silent })
  if (!api || !chatId) {
    console.log(`[video review] #${videoId} (no Telegram): ${v.video_url}\n${text}`)
    return
  }
  const scriptMsg = await api.sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
  })
  const bytes = await storage.download(v.video_url)
  const videoMsg = await api.sendVideo(chatId, new InputFile(bytes, `video-${v.id}.mp4`), {
    caption: cut(
      `🎬 #${v.id} ${v.title ?? ''}\n↑ 원고 · 버튼으로 승인하거나 원고·영상에 답장`,
      VIDEO_CAPTION_LIMIT,
    ),
    reply_markup: reviewKeyboard(v.id, v.revision),
    supports_streaming: true,
    width: 1080,
    height: 1920,
    ...(v.duration_ms ? { duration: Math.round(v.duration_ms / 1000) } : {}),
  })
  const registered = await registerReview(
    v.id,
    v.revision,
    chatId,
    scriptMsg.message_id,
    videoMsg.message_id,
  )
  if (!registered) {
    await clearButtons(chatId, videoMsg.message_id)
    return
  }
  if (v.review_chat_id != null) {
    for (const id of registered.previous) await clearButtons(v.review_chat_id, id)
  }
}

export type VideoBotDeps = {
  onScript: (videoId: number, seq: number) => Promise<void>
  onRender: (videoId: number) => Promise<void>
  onReview: (videoId: number) => Promise<void>
  onPick: () => Promise<void>
}

const errText = (err: unknown) => (err as Error).message.slice(0, 180)

/** Starts (or restarts) a video for a post: `/video <postId>`. Returns the reply text. */
export async function startVideoForPost(postId: number, deps: VideoBotDeps): Promise<string> {
  const created = await createVideo(postId)
  if ('notEligible' in created) return `#${postId}: ${created.notEligible}`
  if ('created' in created) {
    await deps.onScript(created.created, 1)
    return `🎬 #${postId} 글로 영상 #${created.created} 원고를 쓰는 중…`
  }
  const seq = await restartVideo(created.exists)
  if (seq !== null) {
    await deps.onScript(created.exists, seq)
    return `🎬 영상 #${created.exists}를 처음부터 다시 만드는 중…`
  }
  const v = await loadVideo(created.exists)
  return `#${postId} 글은 이미 영상 #${created.exists}가 있어요 (${v?.status ?? '?'})`
}

/** Video handlers, registered through the review bot's `extend` hook (before its text handler). */
export function registerVideoBot(bot: Bot, deps: VideoBotDeps): void {
  bot.command('video', async (ctx) => {
    const arg = ctx.match.trim().replace(/^#/, '')
    try {
      if (!arg) {
        await deps.onPick()
        await ctx.reply('🎬 영상 후보를 고르는 중…')
        return
      }
      const postId = Number(arg)
      if (!Number.isInteger(postId) || postId <= 0) {
        await ctx.reply('사용법: /video [글 번호]')
        return
      }
      await ctx.reply(await startVideoForPost(postId, deps))
    } catch (err) {
      console.error('[video] /video failed', err)
      await ctx.reply(`❌ 영상을 시작하지 못했어요: ${errText(err)}`)
    }
  })

  bot.command('videos', async (ctx) => {
    try {
      const rows = await listVideos()
      if (rows.length === 0) {
        await ctx.reply('아직 영상이 없어요. /video 로 만들어 보세요.')
        return
      }
      const lines = rows.map(
        (r) =>
          `#${r.id} ${r.status} · 글 #${r.post_id} · ${seconds(r.duration_ms)}` +
          (r.scheduled_at ? ` · ${formatVideoTime(r.scheduled_at)} 예정` : '') +
          (r.title ? `\n   ${cut(r.title, 40)}` : ''),
      )
      await ctx.reply(['🎬 영상 목록', ...lines].join('\n'))
    } catch (err) {
      console.error('[video] /videos failed', err)
      await ctx.reply('영상 목록을 불러오지 못했어요.')
    }
  })

  bot.callbackQuery(/^vid:/, async (ctx) => {
    const press = parseVideoAction(ctx.callbackQuery.data)
    const messageId = ctx.callbackQuery.message?.message_id
    if (!press || messageId == null) {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    const guard = { messageId, revision: press.revision }
    const stale = async () => {
      await ctx.answerCallbackQuery({ text: '이전 영상이에요. 최신 검수 메시지에서 눌러주세요' })
      await ctx.editMessageReplyMarkup().catch(() => {})
    }
    try {
      if (press.action === 'ok') {
        let approval: Approval
        try {
          approval = await approveVideo(press.videoId, guard)
        } catch (err) {
          if (err instanceof VideoNotReviewableError) return await stale()
          throw err
        }
        await ctx.editMessageReplyMarkup().catch(() => {})
        await ctx.answerCallbackQuery()
        await ctx.reply(approvedVideoText(press.videoId, approval))
        if (!approval.at) {
          const v = await loadVideo(press.videoId)
          if (v) await sendManualUpload(v)
        }
      } else if (press.action === 'rej') {
        if (!(await rejectVideo(press.videoId, guard))) return await stale()
        await ctx.editMessageReplyMarkup().catch(() => {})
        await ctx.answerCallbackQuery()
        await ctx.reply(`🗑 영상 #${press.videoId} 폐기`)
      } else {
        const seq = await requestRescript(press.videoId, guard, null)
        if (seq === null) return await stale()
        await ctx.editMessageReplyMarkup().catch(() => {})
        await ctx.answerCallbackQuery()
        await ctx.reply(`🔁 영상 #${press.videoId} 원고를 다시 쓰는 중…`)
        await deps.onScript(press.videoId, seq)
      }
    } catch (err) {
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })

  bot.callbackQuery(/^vpub:/, async (ctx) => {
    const id = parsePubRetry(ctx.callbackQuery.data)
    if (id === null) {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    try {
      const at = await retryPublication(id)
      await ctx.editMessageReplyMarkup().catch(() => {})
      if (!at) {
        await ctx.answerCallbackQuery({ text: '다시 시도할 발행이 없어요' })
        return
      }
      await ctx.answerCallbackQuery()
      await ctx.reply(`🔁 ${formatVideoTime(at)}에 다시 발행해요`)
    } catch (err) {
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })

  bot.callbackQuery(/^vman:/, async (ctx) => {
    const id = parseManualDone(ctx.callbackQuery.data)
    if (id === null) {
      await ctx.answerCallbackQuery({ text: '알 수 없는 버튼이에요' })
      return
    }
    try {
      const done = await markManualPublished(id)
      await ctx.editMessageReplyMarkup().catch(() => {})
      await ctx.answerCallbackQuery(done ? {} : { text: '이미 처리된 영상이에요' })
      if (done) await ctx.reply(`📤 영상 #${id} 직접 올림으로 기록했어요`)
    } catch (err) {
      await ctx.answerCallbackQuery({ text: errText(err) }).catch(() => {})
    }
  })

  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id
    if (!replyTo) return next()
    const v = await videoForMessage(replyTo)
    if (!v) return next()
    await handleReply(ctx, v.id, replyTo, ctx.message.text, deps)
  })
}

async function videoForMessage(messageId: number): Promise<{ id: number } | null> {
  const [row] = await query<{ id: number }>(
    `select id from videos where $1 in (review_message_id, script_message_id)
     order by id desc limit 1`,
    [messageId],
  )
  return row ?? null
}

async function handleReply(
  ctx: Context,
  videoId: number,
  replyTo: number,
  text: string,
  deps: VideoBotDeps,
): Promise<void> {
  try {
    const parsed = parseVideoReply(text)
    if (parsed.kind === 'feedback') {
      const seq = await requestRescript(videoId, { replyTo }, text)
      if (seq === null) {
        await ctx.reply('이미 처리됐거나 최신 원고가 아니라서 반영하지 못했어요.')
        return
      }
      await ctx.reply(`🔁 영상 #${videoId} 피드백 반영해서 원고를 다시 쓰는 중…`)
      await deps.onScript(videoId, seq)
      return
    }
    const result = await applyEdit(videoId, { replyTo }, parsed.op)
    if (!result.ok) {
      await ctx.reply(result.message)
      return
    }
    if (result.rerender) {
      await ctx.reply(`🎞 영상 #${videoId} 다시 렌더하는 중…`)
      await deps.onRender(videoId)
    } else {
      await deps.onReview(videoId)
    }
  } catch (err) {
    await ctx.reply(`❌ 반영하지 못했어요: ${errText(err)}`)
  }
}

/**
 * The retry button: a FAILED publication goes to the next free slot. After an expired upload
 * session the owner confirmed nothing went up, so the session is dropped and a new upload starts.
 */
export async function retryPublication(publicationId: number): Promise<Date | null> {
  const [row] = await query<{ error_kind: string | null }>(
    "select error_kind from video_publications where id = $1 and status = 'FAILED'",
    [publicationId],
  )
  if (!row) return null
  return reschedulePublication(publicationId, 'FAILED', {
    clearUpload: row.error_kind === 'session',
  })
}
