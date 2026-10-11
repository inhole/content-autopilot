import { query } from '../db/pool.ts'
import { getThreadsApi } from '../threads/account.ts'
import { THREADS_TEXT_LIMIT, type ThreadsApi, type ThreadsReply } from '../threads/client.ts'
import { driveContainer } from './publish.ts'

/** Replies matter most early, and older posts would only add API calls. */
export const REPLY_POLL_WINDOW_HOURS = 48
/** A reply whose notification failed is retried for this long, then dropped. */
const NOTIFY_RETRY_HOURS = 24
/** A notify/answer claim older than this was left by a crashed process and may be taken over. */
const STALE_CLAIM_MINUTES = 10

export type NewReply = {
  id: string
  post_id: number
  /** Chain part the reply was left on (post_parts idx); null for the main post. */
  part_idx: number | null
  /** Number of posts in the chain, main post included (1 for a single post). */
  chain_length: number
  username: string | null
  text: string | null
  permalink: string | null
  /** Text of the post or part the reply was left on. */
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
  // Same [n/total] numbering as the review message; only shown for chains.
  const where = r.chain_length > 1 ? ` [${r.part_idx ?? 1}/${r.chain_length}]` : ''
  return [
    `💬 @${r.username ?? '알 수 없음'} 답글 · 글 #${r.post_id}${where} "${firstLine}"`,
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

async function insertNewReplies(
  postId: number,
  partIdx: number | null,
  replies: ThreadsReply[],
): Promise<void> {
  for (const r of selectNotifiable(replies)) {
    await query(
      `insert into threads_replies (id, post_id, part_idx, username, text, replied_at, permalink)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [r.id, postId, partIdx, r.username, r.text, r.timestamp, r.permalink],
    )
  }
}

/**
 * Fetches replies of recently published posts and of their published chain parts (a reader can
 * answer any post of a chain), records the unseen ones and notifies the owner.
 * Per-post and per-notification failures are isolated; a failed notification is retried on the
 * next poll because `notified_at` stays null. Returns the replies notified in this run.
 */
export async function pollReplies(send: SendNotification, api?: ThreadsApi): Promise<NewReply[]> {
  // The window follows the main post: a chain's parts go out right after it.
  const targets = await query<{ post_id: number; part_idx: number | null; media_id: string }>(
    `select p.id as post_id, null::smallint as part_idx, p.platform_post_id as media_id
     from posts p
     where p.status = 'PUBLISHED' and p.platform_post_id is not null
       and p.platform_post_id not like 'dry-%'
       and p.published_at > now() - make_interval(hours => $1)
     union all
     select pp.post_id, pp.idx, pp.platform_post_id
     from post_parts pp join posts p on p.id = pp.post_id
     where p.status = 'PUBLISHED' and pp.status = 'PUBLISHED' and pp.platform_post_id is not null
       and pp.platform_post_id not like 'dry-%'
       and p.published_at > now() - make_interval(hours => $1)
     order by post_id, part_idx nulls first`,
    [REPLY_POLL_WINDOW_HOURS],
  )
  if (targets.length > 0) {
    const threads = api ?? (await getThreadsApi())
    for (const t of targets) {
      try {
        await insertNewReplies(t.post_id, t.part_idx, await threads.listReplies(t.media_id))
      } catch (err) {
        const where = t.part_idx === null ? '' : ` part ${t.part_idx}`
        console.warn(`[replies] post #${t.post_id}${where} failed: ${(err as Error).message}`)
      }
    }
  }

  const pending = await query<NewReply>(
    `select r.id, r.post_id, r.part_idx, r.username, r.text, r.permalink,
       coalesce(pp.text, p.text) as post_text,
       1 + (select count(*) from post_parts c where c.post_id = r.post_id)::int as chain_length
     from threads_replies r join posts p on p.id = r.post_id
     left join post_parts pp on pp.post_id = r.post_id and pp.idx = r.part_idx
     where r.notified_at is null and r.created_at > now() - make_interval(hours => $1)
       and (r.notify_claimed_at is null or r.notify_claimed_at < now() - make_interval(mins => $2))
     order by r.replied_at nulls last, r.created_at`,
    [NOTIFY_RETRY_HOURS, STALE_CLAIM_MINUTES],
  )
  const notified: NewReply[] = []
  for (const r of pending) {
    // Claimed first so a concurrent poll (CLI and worker) cannot notify the same reply twice.
    // notified_at is set only once the message id is saved; a claim left by a crash expires, so
    // the reply is notified again rather than never (a duplicate beats a lost notification).
    const claimed = await query(
      `update threads_replies set notify_claimed_at = now()
       where id = $1 and notified_at is null
         and (notify_claimed_at is null or notify_claimed_at < now() - make_interval(mins => $2))
       returning id`,
      [r.id, STALE_CLAIM_MINUTES],
    )
    if (claimed.length === 0) continue
    try {
      const messageId = await send(formatReplyNotification(r))
      await query(
        'update threads_replies set notified_at = now(), telegram_message_id = $2 where id = $1',
        [r.id, messageId],
      )
      notified.push(r)
    } catch (err) {
      console.warn(`[replies] notify ${r.id} failed: ${(err as Error).message}`)
      await query('update threads_replies set notify_claimed_at = null where id = $1', [r.id])
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

const containerStatus = (api: ThreadsApi, id: string) =>
  api.getContainerStatus(id).then(
    (s) => s.status as string,
    () => 'unknown',
  )

/**
 * Posts the owner's answer to the Threads reply behind a Telegram notification. Each reply is
 * answered once: the atomic claim stops a double send, and the container id saved before
 * publishing lets a later attempt see that a "failed" one was in fact published (lost response)
 * instead of posting again. A failure that is known not to have published releases the claim so
 * the owner can retry; an unclear one keeps it until it goes stale and the next attempt re-checks.
 * Returns null when the message is not a reply notification.
 */
export async function answerReply(
  telegramMessageId: number,
  text: string,
  api?: ThreadsApi,
): Promise<{ permalink: string | null } | null> {
  if (!(await isReplyNotification(telegramMessageId))) return null
  const answer = validateAnswer(text)
  const [claimed] = await query<{
    id: string
    permalink: string | null
    answer_container_id: string | null
  }>(
    `update threads_replies
     set answer_state = 'ANSWERING', answer_text = $2, answer_claimed_at = now()
     where telegram_message_id = $1
       and (answer_state is null
         or (answer_state = 'ANSWERING' and answer_claimed_at < now() - make_interval(mins => $3)))
     returning id, permalink, answer_container_id`,
    [telegramMessageId, answer, STALE_CLAIM_MINUTES],
  )
  if (!claimed) throw new Error('이미 답글을 달았거나 달고 있는 답글이에요.')

  const threads = api ?? (await getThreadsApi())
  const done = { permalink: claimed.permalink }
  const markAnswered = (mediaId: string | null) =>
    query(
      `update threads_replies set answer_state = 'ANSWERED', answer_media_id = $2 where id = $1`,
      [claimed.id, mediaId],
    )

  // A previous attempt may have published and then lost the response or crashed.
  if (
    claimed.answer_container_id &&
    (await containerStatus(threads, claimed.answer_container_id)) === 'PUBLISHED'
  ) {
    await markAnswered(null)
    return done
  }

  let containerId: string | null = null
  try {
    // Always a fresh container: an unpublished old one may carry an earlier answer text.
    const { platformPostId } = await driveContainer(
      threads,
      { text: answer, replyToId: claimed.id },
      null,
      async (id) => {
        containerId = id
        await query('update threads_replies set answer_container_id = $2 where id = $1', [
          claimed.id,
          id,
        ])
      },
    )
    await markAnswered(platformPostId)
    return done
  } catch (err) {
    const status = containerId ? await containerStatus(threads, containerId) : null
    if (status === 'PUBLISHED') {
      await markAnswered(null).catch(() => {})
      return done
    }
    if (status !== 'unknown') {
      await query(
        `update threads_replies set answer_state = null, answer_text = null
         where id = $1 and answer_state = 'ANSWERING'`,
        [claimed.id],
      ).catch(() => {})
    }
    throw err
  }
}
