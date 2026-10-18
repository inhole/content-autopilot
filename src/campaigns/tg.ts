import { Api, InlineKeyboard } from 'grammy'
import { config } from '../config.ts'
import { type CampaignCallback, encodeCampaignCallback } from './callbacks.ts'

/**
 * Send-only Telegram access for the campaign pipeline. Sending works from the CLI too,
 * since it never conflicts with the worker's polling. Without a bot token or chat id it logs.
 */
export type CampaignButton =
  | { text: string; callback: CampaignCallback }
  | { text: string; url: string }

export const PHOTO_CAPTION_LIMIT = 1024

let api: Api | null | undefined

export function telegramApi(): Api | null {
  if (api === undefined) api = config.TELEGRAM_BOT_TOKEN ? new Api(config.TELEGRAM_BOT_TOKEN) : null
  return api
}

/** For tests: replaces the Api (null = log only). */
export function setTelegramApi(next: Api | null | undefined): void {
  api = next
}

/** One button per row, in order. */
export function buttonsKeyboard(buttons: CampaignButton[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const b of buttons) {
    if ('url' in b) kb.url(b.text, b.url).row()
    else kb.text(b.text, encodeCampaignCallback(b.callback)).row()
  }
  return kb
}

/** Sends a message and returns its id, or null when Telegram is not configured. */
export async function sendCampaignMessage(
  text: string,
  buttons: CampaignButton[] = [],
): Promise<number | null> {
  const a = telegramApi()
  const chatId = config.TELEGRAM_CHAT_ID
  if (!a || !chatId) {
    console.log(`[campaign notify] ${text}`)
    return null
  }
  const msg = await a.sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
    ...(buttons.length ? { reply_markup: buttonsKeyboard(buttons) } : {}),
  })
  return msg.message_id
}

/**
 * Sends a photo (by URL) with a caption and returns the message id. Falls back to a text message
 * when Telegram rejects the photo (unreachable URL, unsupported format, too large).
 */
export async function sendCampaignPhotoMessage(
  imageUrl: string,
  caption: string,
  buttons: CampaignButton[] = [],
): Promise<number | null> {
  const a = telegramApi()
  const chatId = config.TELEGRAM_CHAT_ID
  if (!a || !chatId) {
    console.log(`[campaign notify] ${caption}`)
    return null
  }
  try {
    const msg = await a.sendPhoto(chatId, imageUrl, {
      caption: [...caption].slice(0, PHOTO_CAPTION_LIMIT).join(''),
      ...(buttons.length ? { reply_markup: buttonsKeyboard(buttons) } : {}),
    })
    return msg.message_id
  } catch (err) {
    console.warn('[campaign] photo send failed, falling back to text', (err as Error).message)
    return sendCampaignMessage(caption, buttons)
  }
}

/** Best effort: the message may be deleted or too old to edit. */
export async function clearButtons(chatId: number, messageId: number): Promise<void> {
  await telegramApi()
    ?.editMessageReplyMarkup(chatId, messageId)
    .catch(() => {})
}
