import type { Bot } from 'grammy'
import type { PgBoss } from 'pg-boss'
import { config } from '../config.ts'
import type { Reviewer } from '../review/telegram.ts'
import { buildWeeklyDigest } from './digest.ts'

// The weekly "이번 주 놓친 소식" job (docs/plans/roadmap.md 1) and its /digest command.

export const DIGEST_QUEUE = 'weekly-digest'
const DIGEST_RETRY_LIMIT = 1
/** Sunday 18:00 in TZ_NAME. */
export const DIGEST_CRON = '0 18 * * 0'

export const DIGEST_HELP_LINES = [
  '🗞 주간 묶음',
  '/digest — 만료된 초안을 이번 주 놓친 소식 연결 글로 지금 묶기 (매주 일요일 18시에도 자동)',
]

export const DIGEST_BOT_COMMANDS = [{ command: 'digest', description: '이번 주 놓친 소식 묶기' }]

/** Queues a digest build now; stately, so a second press while one is queued does nothing. */
export const enqueueDigest = (boss: PgBoss) => boss.send(DIGEST_QUEUE, null)

/** Registers `/digest`. Must run before the `message:text` handler, like every command. */
export function registerDigestBot(bot: Bot, deps: { onDigest: () => Promise<void> }): void {
  bot.command('digest', async (ctx) => {
    await ctx.reply('🗞 이번 주 놓친 소식을 묶는 중…')
    try {
      await deps.onDigest()
    } catch (err) {
      console.error('[telegram] /digest failed', err)
      await ctx.reply('묶음 글을 만들지 못했어요. 로그를 확인해 주세요.')
    }
  })
}

/** Creates the queue and its Sunday schedule, and the worker that builds and sends the digest. */
export async function registerDigestJobs(boss: PgBoss, reviewer: Reviewer): Promise<void> {
  await boss.createQueue(DIGEST_QUEUE, {
    policy: 'stately',
    retryLimit: DIGEST_RETRY_LIMIT,
    retryDelay: 600,
  })
  await boss.schedule(DIGEST_QUEUE, DIGEST_CRON, null, { tz: config.TZ_NAME })
  await boss.work(DIGEST_QUEUE, async ([job]) => {
    if (!job) return
    const postId = await buildWeeklyDigest()
    if (postId === null) {
      console.log('[digest] fewer than 2 expired drafts to fold, nothing sent')
      return
    }
    await reviewer.sendForReview(postId)
    console.log(`[digest] sent #${postId} for review`)
  })
}
