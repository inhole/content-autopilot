import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { embed } from '../llm/openrouter.ts'

// Cosine similarity at or above this marks a topic as the same story as an earlier one.
// Tune with real data: cross-language pairs (GeekNews KR vs HN EN) score lower than same-language.
export const DUPLICATE_SIMILARITY = 0.85
const LOOKBACK_DAYS = 14

export const toVector = (v: number[]) => `[${v.join(',')}]`

export async function dedupeCollected(): Promise<{ embedded: number; duplicates: number }> {
  const pending = await query<{ id: number; title: string; feed_summary: string | null }>(
    `select id, title, feed_summary from topics
     where status = 'COLLECTED' and embedding is null order by id`,
  )
  if (pending.length > 0) {
    const vectors = await embed(
      config.EMBEDDING_MODEL,
      pending.map((t) => `${t.title}\n${t.feed_summary ?? ''}`.slice(0, 4000)),
    )
    for (const [i, topic] of pending.entries()) {
      await query('update topics set embedding = $2::vector where id = $1', [
        topic.id,
        toVector(vectors[i] ?? []),
      ])
    }
  }

  // Compare each new topic only against earlier ones, so the first occurrence of a story wins.
  const candidates = await query<{ id: number }>(
    "select id from topics where status = 'COLLECTED' and embedding is not null order by id",
  )
  let duplicates = 0
  for (const { id } of candidates) {
    const [nearest] = await query<{ id: number; similarity: number }>(
      `select o.id, 1 - (o.embedding <=> t.embedding) as similarity
       from topics t, topics o
       where t.id = $1 and o.id < t.id and o.status <> 'DUPLICATE' and o.embedding is not null
         and o.created_at > now() - make_interval(days => $2)
       order by o.embedding <=> t.embedding
       limit 1`,
      [id, LOOKBACK_DAYS],
    )
    if (nearest && nearest.similarity >= DUPLICATE_SIMILARITY) {
      await query(
        "update topics set status = 'DUPLICATE', duplicate_of = $2, updated_at = now() where id = $1",
        [id, nearest.id],
      )
      duplicates++
    }
  }
  return { embedded: pending.length, duplicates }
}
