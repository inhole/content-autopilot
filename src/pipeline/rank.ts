import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { expireStaleTopics } from './collect.ts'
import { RANK_SYSTEM } from './prompts.ts'

const MAX_CANDIDATES = 100
// Recently covered topics are shown to the ranker so it can flag repeats across days and languages.
const RECENT_DAYS = 14

const rankSchema = z.object({
  scores: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().min(0).max(10),
      reason: z.string(),
      duplicate_of: z.number().int().nullable(),
    }),
  ),
})

type Candidate = { id: number; title: string; feed_summary: string | null; source: string }

type Score = { id: number; score: number; duplicate_of: number | null }

/**
 * Drops duplicate labels that would hide a story entirely: references to unknown ids, self
 * references, and mutual pairs (the higher-scored side of a mutual pair is kept).
 */
export function resolveDuplicates<T extends Score>(scores: T[], known: Set<number>): T[] {
  const byId = new Map(scores.map((s) => [s.id, s]))
  return scores.map((s) => {
    const target = s.duplicate_of
    if (target === null) return s
    if (target === s.id || !known.has(target)) return { ...s, duplicate_of: null }
    const other = byId.get(target)
    if (other?.duplicate_of === s.id) {
      const keep = s.score > other.score || (s.score === other.score && s.id < other.id)
      if (keep) return { ...s, duplicate_of: null }
    }
    return s
  })
}

/** Pick the top `count` non-duplicate topics. A fixed count keeps daily volume stable. */
export function pickTop(scores: Score[], candidateIds: Set<number>, count: number): number[] {
  return scores
    .filter((s) => candidateIds.has(s.id) && s.duplicate_of === null)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((s) => s.id)
}

export async function rankCollected(count = config.DAILY_POST_COUNT): Promise<number[]> {
  await expireStaleTopics()
  const candidates = await query<Candidate>(
    `select t.id, t.title, t.feed_summary, s.name as source
     from topics t join sources s on s.id = t.source_id
     where t.status = 'COLLECTED'
     order by coalesce(t.published_at, t.created_at) desc
     limit $1`,
    [MAX_CANDIDATES],
  )
  if (candidates.length === 0) return []
  const recent = await query<{ id: number; title: string }>(
    `select id, title from topics
     where status = 'USED' and updated_at > now() - make_interval(days => $1)
     order by updated_at desc`,
    [RECENT_DAYS],
  )

  const list = candidates
    .map((c) => `[${c.id}] (${c.source}) ${c.title}\n${(c.feed_summary ?? '').slice(0, 300)}`)
    .join('\n\n')
  const recentList = recent.length ? recent.map((t) => `[${t.id}] ${t.title}`).join('\n') : '(없음)'
  const { scores: raw } = await chatJson({
    model: config.LLM_RANK_MODEL,
    system: RANK_SYSTEM,
    user: `최근 다룬 주제:\n${recentList}\n\n후보 ${candidates.length}개를 모두 평가해라.\n\n${list}`,
    schema: rankSchema,
    schemaName: 'topic_scores',
    temperature: 0,
  })

  const ids = new Set(candidates.map((c) => c.id))
  const scores = resolveDuplicates(
    raw.filter((s) => ids.has(s.id)),
    new Set([...ids, ...recent.map((t) => t.id)]),
  )
  for (const s of scores) {
    await query(
      `update topics set score = $2, score_reason = $3, duplicate_of = $4,
         status = case when $4::bigint is null then status else 'DUPLICATE' end,
         updated_at = now()
       where id = $1`,
      [s.id, s.score, s.reason, s.duplicate_of],
    )
  }
  const picked = pickTop(scores, ids, count)
  await query(
    `update topics set status = case when id = any($1::bigint[]) then 'SHORTLISTED' else 'SKIPPED' end,
       updated_at = now()
     where id = any($2::bigint[]) and status = 'COLLECTED'`,
    [picked, [...ids]],
  )
  return picked
}
