import type { ThreadsApi, ThreadsOwnPost } from './client.ts'

// Read-only check of the Threads API behaviour the publisher relies on (docs/setup.md 4-4):
// token owner, /me/threads and /me/replies ordering, the replied_to field that chain recovery
// needs, and the insights / replies scopes. It never publishes and never touches the database.

type Step<T> = ({ ok: true } & T) | { ok: false; error: string }

export type ProbeReport = {
  me: Step<{ id: string; username: string }>
  threads: Step<{ count: number; newestFirst: boolean; sample: ThreadsOwnPost[] }>
  replies: Step<{ count: number; withRepliedTo: number; newestFirst: boolean }>
  insights: Step<{ mediaId: string; metrics: string[] }> | null
  readReplies: Step<{ mediaId: string; count: number }> | null
}

async function step<T>(fn: () => Promise<T>): Promise<Step<T>> {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Items with a timestamp never get newer further down the list. */
export function isNewestFirst(items: ThreadsOwnPost[]): boolean {
  const times = items.flatMap((i) => (i.timestamp ? [i.timestamp.getTime()] : []))
  return times.every((t, i) => i === 0 || t <= (times[i - 1] as number))
}

export async function runProbe(api: ThreadsApi): Promise<ProbeReport> {
  const me = await step(() => api.me())
  let firstThread: string | undefined
  const threads = await step(async () => {
    const items = await api.listMyThreads()
    firstThread = items[0]?.id
    return { count: items.length, newestFirst: isNewestFirst(items), sample: items.slice(0, 3) }
  })
  const replies = await step(async () => {
    const items = await api.listMyReplies()
    return {
      count: items.length,
      withRepliedTo: items.filter((i) => i.repliedToId !== null).length,
      newestFirst: isNewestFirst(items),
    }
  })
  const mediaId = firstThread
  const insights = mediaId
    ? await step(async () => {
        const m = await api.getInsights(mediaId)
        return { mediaId, metrics: Object.keys(m).filter((k) => m[k as keyof typeof m] !== null) }
      })
    : null
  const readReplies = mediaId
    ? await step(async () => ({ mediaId, count: (await api.listReplies(mediaId)).length }))
    : null
  return { me, threads, replies, insights, readReplies }
}

const mark = (ok: boolean) => (ok ? 'OK  ' : 'FAIL')
const preview = (text: string | null) => (text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 40)

export function formatProbe(r: ProbeReport): string {
  const lines: string[] = []
  lines.push(
    r.me.ok
      ? `${mark(true)} token owner: @${r.me.username} (${r.me.id})`
      : `${mark(false)} token owner: ${r.me.error}`,
  )
  if (r.threads.ok) {
    lines.push(
      `${mark(r.threads.newestFirst)} /me/threads: ${r.threads.count} item(s), ` +
        `${r.threads.newestFirst ? 'newest first' : 'NOT newest first (recovery assumes it)'}`,
    )
    for (const t of r.threads.sample) {
      lines.push(`       ${t.id} ${t.timestamp?.toISOString() ?? '-'} ${preview(t.text)}`)
    }
  } else {
    lines.push(`${mark(false)} /me/threads: ${r.threads.error}`)
  }
  if (!r.replies.ok) {
    lines.push(`${mark(false)} /me/replies: ${r.replies.error}`)
  } else if (r.replies.count === 0) {
    lines.push(
      '?    /me/replies: no replies on this account, so replied_to cannot be checked. ' +
        'Reply to any post once in the app and run this again.',
    )
  } else {
    const all = r.replies.withRepliedTo === r.replies.count
    lines.push(
      `${mark(all)} /me/replies: replied_to on ${r.replies.withRepliedTo}/${r.replies.count}` +
        (all ? '' : ' (chain parts with a lost publish response cannot be recovered)') +
        `, ${r.replies.newestFirst ? 'newest first' : 'NOT newest first'}`,
    )
  }
  if (r.insights) {
    lines.push(
      r.insights.ok
        ? `${mark(true)} insights (${r.insights.mediaId}): ${r.insights.metrics.join(', ') || 'no metrics'}`
        : `${mark(false)} insights: ${r.insights.error} (threads_manage_insights scope?)`,
    )
  }
  if (r.readReplies) {
    lines.push(
      r.readReplies.ok
        ? `${mark(true)} replies of ${r.readReplies.mediaId}: ${r.readReplies.count}`
        : `${mark(false)} replies of a post: ${r.readReplies.error} (threads_read_replies scope?)`,
    )
  }
  if (!r.insights) lines.push('?    insights / replies: no post on this account to check them on')
  return lines.join('\n')
}
