import type { Bot, InlineKeyboard } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { config } from '../config.ts'
import { formatFinalFailure, isFinalAttempt } from '../jobs.ts'
import type { Reviewer } from '../review/telegram.ts'
import { judgeExpired, reviveDraft } from './revive.ts'
import { formatReviveList, reviveKeyboard } from './revive-bot.ts'

export const REVIVE_QUEUES = { check: 'revive-check', revive: 'revive' } as const
const CHECK_RETRY_LIMIT = 1
const REVIVE_RETRY_LIMIT = 1

/** Sends text with an inline keyboard to the owner chat (Reviewer has no keyboard API). */
export type SendWithKeyboard = (text: string, keyboard: InlineKeyboard) => Promise<void>

/**
 * Builds the keyboard-capable sender from the review bot, i.e. the Bot handed to the `extend`
 * hook of createReviewer. Without a chat id it logs instead.
 */
export function sendWithKeyboardVia(bot: Bot): SendWithKeyboard {
  return async (text, keyboard) => {
    if (!config.TELEGRAM_CHAT_ID) {
      console.log(`[revive] ${text}`)
      return
    }
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, { reply_markup: keyboard })
  }
}

export const enqueueReviveCheck = (boss: PgBoss) => boss.send(REVIVE_QUEUES.check, {})

export const enqueueRevive = (boss: PgBoss, postId: number) =>
  boss.send(REVIVE_QUEUES.revive, { postId }, { singletonKey: `revive-${postId}` })

async function alertOnFinalFailure(
  job: { retryCount: number },
  retryLimit: number,
  label: string,
  reviewer: Reviewer,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (isFinalAttempt(job.retryCount, retryLimit)) {
      await reviewer.notify(formatFinalFailure(label, err)).catch(() => {})
    }
    throw err
  }
}

/** Creates the revive queues and their workers. `send` posts the list together with its buttons. */
export async function registerReviveJobs(
  boss: PgBoss,
  reviewer: Reviewer,
  send: SendWithKeyboard,
): Promise<void> {
  await boss.createQueue(REVIVE_QUEUES.check, {
    policy: 'stately',
    retryLimit: CHECK_RETRY_LIMIT,
    retryDelay: 60,
  })
  await boss.createQueue(REVIVE_QUEUES.revive, {
    policy: 'singleton',
    retryLimit: REVIVE_RETRY_LIMIT,
    retryDelay: 60,
  })

  await boss.work(REVIVE_QUEUES.check, async ([job]) => {
    if (!job) return
    await alertOnFinalFailure(job, CHECK_RETRY_LIMIT, '만료 초안 판정', reviewer, async () => {
      const posts = await judgeExpired()
      await send(formatReviveList(posts, new Date(), config.TZ_NAME), reviveKeyboard(posts))
    })
  })

  await boss.work<{ postId: number }>(REVIVE_QUEUES.revive, async ([job]) => {
    if (!job) return
    const { postId } = job.data
    const label = `초안 #${postId} 되살리기`
    await alertOnFinalFailure(job, REVIVE_RETRY_LIMIT, label, reviewer, async () => {
      if (await reviveDraft(postId)) await reviewer.sendForReview(postId)
      else await reviewer.notify('이미 처리된 초안이에요')
    })
  })
}
