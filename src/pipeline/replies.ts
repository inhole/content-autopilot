import { query } from '../db/pool.ts'
import { getThreadsApi } from '../threads/account.ts'
import { THREADS_TEXT_LIMIT, type ThreadsApi, type ThreadsReply } from '../threads/client.ts'

/** Replies matter most early, and older posts would only add API calls. */
export const REPLY_POLL_WINDOW_HOURS = 48
/** A reply whose notification failed is retried for this long, then dropped. */
const NOTIFY_RETRY_HOURS = 24

export type NewReply = {
  id: string
  post_id: number
  username: string | null
  text: string | null
  permalink: string | null
  post_text: string
}

/** Sends a message to the owner chat and returns its Telegram message id (null without Telegram). */
export type SendNotification = (text: string) => Promise<number | null>

/** Drops our own replies and ones the owner has hidden; neither needs the owner's attention. */
export function selectNotifiable(replies: ThreadsReply[]): ThreadsReply[] {
  return replies.filter((r) => !r.isOwnedByMe && !r.hidden)
}

const shorten = (s: string, max: number) => {
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s
}

export function formatReplyNotification(r: NewReply): string {
  const firstLine = shorten((r.post_text.split('\n')[0] ?? '').trim(), 30)
  return [
    `💬 @${r.username ?? '알 수 없음'} 답글 · 글 #${r.post_id} "${firstLine}"`,
    '',
    r.text ?? '(텍스트가 없는 답글이에요)',
    ...(r.permalink ? ['', r.permalink] : []),
    '',
    '이 메시지에 답장하면 Threads 답글로 달려요.',
  ].join('\n')
}

/** Checks the owner's answer before it is posted; returns the trimmed text. */
export function validateAnswer(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('답글 내용이 비어 있어요.')
  const length = [...trimmed].length
  if (length > THREADS_TEXT_LIMIT) {
    throw new Error(`답글은 ${THREADS_TEXT_LIMIT}자까지예요 (현재 ${length}자).`)
  }
  return trimmed
}

async function insertNewReplies(postId: number, replies: ThreadsReply[]): Promise<void> {
  for (const r of selectNotifiable(replies)) {
    await query(
      `insert into threads_replies (id, post_id, username, text, replied_at, permalink)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [r.id, postId, r.username, r.text, r.timestamp, r.permalink],
    )
  }
}

/**
 * Fetches replies of recently published posts, records the unseen ones and notifies the owner.
 * Per-post and per-notification failures are isolated; a failed notification is retried on the
 * next poll because `notified_at` stays null. Returns the replies notified in this run.
 */
export async function pollReplies(send: SendNotification, api?: ThreadsApi): Promise<NewReply[]> {
  const posts = await query<{ id: number; platform_post_id: string }>(
    `select id, platform_post_id from posts
     where status = 'PUBLISHED' and platform_post_id is not null
       and platform_post_id not like 'dry-%'
       and published_at > now() - make_interval(hours => $1)
     order by id`,
    [REPLY_POLL_WINDOW_HOURS],
  )
  if (posts.length > 0) {
    const threads = api ?? (await getThreadsApi())
    for (const p of posts) {
      try {
        await insertNewReplies(p.id, await threads.listReplies(p.platform_post_id))
      } catch (err) {
        console.warn(`[replies] post #${p.id} failed: ${(err as Error).message}`)
      }
    }
  }

  const pending = await query<NewReply>(
    `select r.id, r.post_id, r.username, r.text, r.permalink, p.text as post_text
     from threads_replies r join posts p on p.id = r.post_id
     where r.notified_at is null and r.created_at > now() - make_interval(hours => $1)
     order by r.replied_at nulls last, r.created_at`,
    [NOTIFY_RETRY_HOURS],
  )
  const notified: NewReply[] = []
  for (const r of pending) {
    // Claimed first so a concurrent poll (CLI and worker) cannot notify the same reply twice.
    const claimed = await query(
      'update threads_replies set notified_at = now() where id = $1 and notified_at is null returning id',
      [r.id],
    )
    if (claimed.length === 0) continue
    try {
      const messageId = await send(formatReplyNotification(r))
      if (messageId != null) {
        await query('update threads_replies set telegram_message_id = $2 where id = $1', [
          r.id,
          messageId,
        ])
      }
      notified.push(r)
    } catch (err) {
      console.warn(`[replies] notify ${r.id} failed: ${(err as Error).message}`)
      await query('update threads_replies set notified_at = null where id = $1', [r.id])
    }
  }
  return notified
}

async function isReplyNotification(telegramMessageId: number): Promise<boolean> {
  const rows = await query('select 1 from threads_replies where telegram_message_id = $1', [
    telegramMessageId,
  ])
  return rows.length > 0
}

/**
 * Posts the owner's answer to the Threads reply behind a Telegram notification. Each reply can be
 * answered once: the atomic claim means a double send or a retry never posts twice. On failure the
 * claim is released so the owner can try again. Returns null when the message is not a reply
 * notification.
 */
export async function answerReply(
  telegramMessageId: number,
  text: string,
  api?: ThreadsApi,
): Promise<{ permalink: string | null } | null> {
  if (!(await isReplyNotification(telegramMessageId))) return null
  const answer = validateAnswer(text)
  const [claimed] = await query<{ id: string; permalink: string | null }>(
    `update threads_replies set answer_state = 'ANSWERING', answer_text = $2
     where telegram_message_id = $1 and answer_state is null
     returning id, permalink`,
    [telegramMessageId, answer],
  )
  if (!claimed) throw new Error('이미 답글을 달았거나 달고 있는 답글이에요.')
  try {
    const mediaId = await (api ?? (await getThreadsApi())).replyTo(claimed.id, answer)
    await query(
      `update threads_replies set answer_state = 'ANSWERED', answer_media_id = $2 where id = $1`,
      [claimed.id, mediaId],
    )
  } catch (err) {
    await query(
      `update threads_replies set answer_state = null, answer_text = null
       where id = $1 and answer_state = 'ANSWERING'`,
      [claimed.id],
    ).catch(() => {})
    throw err
  }
  return { permalink: claimed.permalink }
}
