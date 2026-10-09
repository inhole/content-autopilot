import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'
import { fetchArticle, TransientFetchError } from './article.ts'
import { GENERATE_SYSTEM } from './prompts.ts'

export const generationSchema = z.object({
  text: z.string().min(50).max(THREADS_TEXT_LIMIT),
  angle: z.string(),
  topic_tag: z.string().max(50),
  caveats: z.array(z.string()),
})
export type Generation = z.infer<typeof generationSchema>

type Topic = { id: number; title: string; url: string | null; feed_summary: string | null }

export class SkipTopicError extends Error {}

export type GenerateOptions = {
  /** Replace an existing PENDING_REVIEW draft instead of reusing it. */
  regenerate?: boolean
  feedback?: string
}

/** SHORTLISTED topics that never got a draft, e.g. because enqueueing crashed after ranking. */
export async function pendingShortlistedTopicIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select t.id from topics t
     where t.status = 'SHORTLISTED'
       and not exists (select 1 from posts p where p.topic_id = t.id and p.platform = 'THREADS')
     order by t.id`,
  )
  return rows.map((r) => r.id)
}

/**
 * Generates (or regenerates) the Threads draft for a topic and leaves it PENDING_REVIEW.
 * Returns the post id, or null when there is nothing to review (the post was rejected or has
 * moved past review). An initial generation reuses an existing PENDING_REVIEW draft so job
 * retries never overwrite edits; only an explicit regeneration replaces the text.
 */
export async function generatePost(
  topicId: number,
  options: GenerateOptions = {},
): Promise<number | null> {
  const { regenerate = false, feedback } = options
  const [topic] = await query<Topic>(
    'select id, title, url, feed_summary from topics where id = $1',
    [topicId],
  )
  if (!topic) throw new Error(`topic ${topicId} not found`)

  const [existing] = await query<{ id: number; text: string; status: string }>(
    "select id, text, status from posts where topic_id = $1 and platform = 'THREADS'",
    [topicId],
  )
  if (existing && existing.status !== 'PENDING_REVIEW') return null
  if (existing && !regenerate) return existing.id

  const body = await articleBody(topic)
  if (!body) {
    await query("update topics set status = 'SKIPPED', updated_at = now() where id = $1", [topicId])
    throw new SkipTopicError(`topic ${topicId}: no readable article body`)
  }

  const revision =
    existing && feedback
      ? `\n\n이전 초안:\n${existing.text}\n\n검수자 피드백: ${feedback}\n피드백을 반영해 새로 써라.`
      : ''

  const gen = await chatJson({
    model: config.LLM_MODEL,
    system: GENERATE_SYSTEM,
    user: `제목: ${topic.title}\n출처: ${topic.url ?? '(직접 입력)'}\n\n본문:\n${body}${revision}`,
    schema: generationSchema,
    schemaName: 'threads_post',
  })

  // The status guard also protects against a reject/approve that landed while the LLM ran.
  const [post] = await query<{ id: number }>(
    `insert into posts (topic_id, text, angle, source_url, generation, status)
     values ($1, $2, $3, $4, $5, 'PENDING_REVIEW')
     on conflict (topic_id, platform) do update
       set text = excluded.text, angle = excluded.angle, generation = excluded.generation,
           status = 'PENDING_REVIEW', updated_at = now()
       where posts.status = 'PENDING_REVIEW'
     returning id`,
    [topic.id, gen.text, gen.angle, topic.url, JSON.stringify(gen)],
  )
  if (!post) return null
  await query("update topics set status = 'USED', updated_at = now() where id = $1", [topicId])
  return post.id
}

async function articleBody(topic: Topic): Promise<string | null> {
  let transient: TransientFetchError | null = null
  if (topic.url) {
    try {
      const article = await fetchArticle(topic.url)
      if (article) return article.text
    } catch (err) {
      // Fall back to the feed summary below. A transient failure with no usable summary
      // must retry the job instead of skipping the topic for good.
      if (err instanceof TransientFetchError) transient = err
      else console.warn(`[generate] topic ${topic.id}: ${(err as Error).message}`)
    }
  }
  const summary = topic.feed_summary?.trim()
  if (summary && summary.length >= 200) return summary
  // Manual topics without a URL: the title itself is the brief.
  if (!topic.url) return topic.title
  if (transient) throw transient
  return null
}
