import { Api, InlineKeyboard } from 'grammy'
import { config } from '../config.ts'
import { type CampaignCallback, encodeCampaignCallback } from './callbacks.ts'

/**
 * Send-only Telegram access for the campaign pipeline. Sending works from the CLI too,
 * since it never conflicts with the worker's polling. Without a bot token or chat id it logs.
 */
export type CampaignButton = { text: string; callback: CampaignCallback }

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
  for (const b of buttons) kb.text(b.text, encodeCampaignCallback(b.callback)).row()
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

/** Best effort: the message may be deleted or too old to edit. */
export async function clearButtons(chatId: number, messageId: number): Promise<void> {
  await telegramApi()
    ?.editMessageReplyMarkup(chatId, messageId)
    .catch(() => {})
}
