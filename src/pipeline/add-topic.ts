import { query } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'
import { fetchArticle } from './article.ts'
import { addManualTopic } from './collect.ts'

export type AddTopicResult = { covered: { postId: number; status: string } } | { topicId: number }

/**
 * Creates a manual topic from an article URL (Telegram `/add` and the web console). `url` must
 * already be a valid http(s) URL: the callers validate it (parseAddCommand, the HTTP schema).
 * An article that already has a post is reported as `covered` and nothing is created.
 */
export async function addTopicFromUrl(url: string, note?: string): Promise<AddTopicResult> {
  const [covered] = await query<{ id: number; status: string }>(
    `select p.id, p.status from posts p join topics t on t.id = p.topic_id
     where t.url_hash = $1 order by p.id desc limit 1`,
    [urlHash(url)],
  )
  if (covered) return { covered: { postId: covered.id, status: covered.status } }
  // A failed fetch must not block adding the topic; generation fetches the body again anyway.
  const title = await fetchArticle(url)
    .then((a) => a?.title?.trim() || url)
    .catch(() => url)
  return { topicId: await addManualTopic(title, url, note) }
}
