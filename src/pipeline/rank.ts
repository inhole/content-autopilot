import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { RANK_SYSTEM } from './prompts.ts'

const MAX_CANDIDATES = 60

const rankSchema = z.object({
  scores: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().min(0).max(10),
      reason: z.string(),
    }),
  ),
})

type Candidate = { id: number; title: string; feed_summary: string | null; source: string }

/** Pick the top `count` scored topics. A fixed count keeps daily volume stable. */
export function pickTop(
  scores: { id: number; score: number }[],
  candidateIds: Set<number>,
  count: number,
): number[] {
  return scores
    .filter((s) => candidateIds.has(s.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((s) => s.id)
}

export async function rankCollected(count = config.DAILY_POST_COUNT): Promise<number[]> {
  const candidates = await query<Candidate>(
    `select t.id, t.title, t.feed_summary, s.name as source
     from topics t join sources s on s.id = t.source_id
     where t.status = 'COLLECTED' and t.embedding is not null
     order by coalesce(t.published_at, t.created_at) desc
     limit $1`,
    [MAX_CANDIDATES],
  )
  if (candidates.length === 0) return []

  const list = candidates
    .map((c) => `[${c.id}] (${c.source}) ${c.title}\n${(c.feed_summary ?? '').slice(0, 300)}`)
    .join('\n\n')
  const { scores } = await chatJson({
    model: config.LLM_RANK_MODEL,
    system: RANK_SYSTEM,
    user: `후보 ${candidates.length}개를 모두 평가해라.\n\n${list}`,
    schema: rankSchema,
    schemaName: 'topic_scores',
    temperature: 0,
  })

  const ids = new Set(candidates.map((c) => c.id))
  for (const s of scores) {
    if (!ids.has(s.id)) continue
    await query(
      'update topics set score = $2, score_reason = $3, updated_at = now() where id = $1',
      [s.id, s.score, s.reason],
    )
  }
  const picked = pickTop(scores, ids, count)
  await query(
    `update topics set status = case when id = any($1::bigint[]) then 'SHORTLISTED' else 'SKIPPED' end,
       updated_at = now()
     where id = any($2::bigint[])`,
    [picked, [...ids]],
  )
  return picked
}
