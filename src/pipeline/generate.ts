import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'
import { GENERATE_SYSTEM } from './prompts.ts'
import { gatherSources } from './sources.ts'
import { buildStylePrompt, loadStyleContext } from './style.ts'

export const generationSchema = z.object({
  text: z.string().min(50).max(THREADS_TEXT_LIMIT),
  angle: z.string(),
  topic_tag: z.string().max(50),
  caveats: z.array(z.string()),
})
export type Generation = z.infer<typeof generationSchema>

type Topic = {
  id: number
  title: string
  url: string | null
  discussion_url: string | null
  feed_summary: string | null
  note: string | null
}

export class SkipTopicError extends Error {}

export type GenerateOptions = {
  /** Replace an existing PENDING_REVIEW draft instead of reusing it. */
  regenerate?: boolean
  feedback?: string
  /**
   * `posts.regen_seq` of the request (see requestRegeneration). The write is dropped if a newer
   * request exists, so a retried older request never overwrites a newer result.
   */
  seq?: number
}

const markUsed = (topicId: number) =>
  query("update topics set status = 'USED', updated_at = now() where id = $1", [topicId])

/**
 * Registers a regeneration request and returns its sequence number, or null when the topic has
 * no draft under review. Only the latest request's result is kept (see GenerateOptions.seq).
 */
export async function requestRegeneration(topicId: number): Promise<number | null> {
  const [row] = await query<{ regen_seq: number }>(
    `update posts set regen_seq = regen_seq + 1, updated_at = now()
     where topic_id = $1 and platform = 'THREADS' and status = 'PENDING_REVIEW'
     returning regen_seq`,
    [topicId],
  )
  return row?.regen_seq ?? null
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
  const { regenerate = false, feedback, seq } = options
  const [topic] = await query<Topic>(
    'select id, title, url, discussion_url, feed_summary, note from topics where id = $1',
    [topicId],
  )
  if (!topic) throw new Error(`topic ${topicId} not found`)

  const [existing] = await query<{ id: number; text: string; status: string }>(
    "select id, text, status from posts where topic_id = $1 and platform = 'THREADS'",
    [topicId],
  )
  if (existing && existing.status !== 'PENDING_REVIEW') return null
  if (existing && !regenerate) {
    // Also repairs a topic left SHORTLISTED when an earlier run saved the draft but crashed
    // before marking the topic.
    await markUsed(topicId)
    return existing.id
  }

  const sources = await gatherSources(topic)
  if (!sources) {
    await query("update topics set status = 'SKIPPED', updated_at = now() where id = $1", [topicId])
    throw new SkipTopicError(`topic ${topicId}: no readable article body`)
  }

  const revisionPrompt =
    existing && feedback
      ? `\n\n이전 초안:\n${existing.text}\n\n검수자 피드백: ${feedback}\n피드백을 반영해 새로 써라.`
      : ''

  // The note is the owner's opinion (the angle), never a source of facts.
  const notePrompt = topic.note ? `\n\n작성자 의견 (글의 관점으로 삼을 것): ${topic.note}` : ''

  // Style learning (owner's edited/approved posts, recent hooks, reject reasons) is a nice-to-have:
  // a failure to load it must not block the draft.
  const stylePrompt = await loadStyleContext()
    .then(buildStylePrompt)
    .catch((err: unknown) => {
      console.warn(`[generate] style context unavailable: ${(err as Error).message}`)
      return ''
    })

  // Labeled parts joined by blank lines; add new context as another part.
  const parts = [
    `제목: ${topic.title}\n출처: ${sources.sourceUrl ?? '(직접 입력)'}`,
    `본문:\n${sources.body}`,
    ...sources.aux.map((a) => `${a.label}:\n${a.text}`),
    ...(stylePrompt ? [stylePrompt] : []),
  ]

  const gen = await chatJson({
    model: config.LLM_MODEL,
    system: GENERATE_SYSTEM,
    user: `${parts.join('\n\n')}${notePrompt}${revisionPrompt}`,
    schema: generationSchema,
    schemaName: 'threads_post',
  })

  // An initial generation never overwrites: if another job created the draft meanwhile, that
  // draft (and any edit made to it) wins and that job sends it to review.
  // A regeneration only replaces a draft still under review (a reject/approve may have landed
  // while the LLM ran) and only if it is still the latest request.
  const [post] = existing
    ? await query<{ id: number }>(
        `update posts set text = $2, angle = $3, generation = $4, revision = revision + 1,
           updated_at = now()
         where id = $1 and status = 'PENDING_REVIEW' and ($5::int is null or regen_seq = $5)
         returning id`,
        [existing.id, gen.text, gen.angle, JSON.stringify(gen), seq ?? null],
      )
    : await query<{ id: number }>(
        `insert into posts (topic_id, text, angle, source_url, generation, status)
         values ($1, $2, $3, $4, $5, 'PENDING_REVIEW')
         on conflict (topic_id, platform) do nothing
         returning id`,
        [topic.id, gen.text, gen.angle, sources.sourceUrl, JSON.stringify(gen)],
      )
  if (!post) return null
  await markUsed(topicId)
  return post.id
}
