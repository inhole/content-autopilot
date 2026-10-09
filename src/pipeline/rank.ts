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
 * Checks that the ranker scored every candidate exactly once and returns only the scores for
 * candidates. Unknown ids are ignored (the model may echo a recent-topic id; they carry no data we
 * can use). Missing or repeated candidate ids throw so the job retries before anything is written.
 */
export function validateScores<T extends { id: number }>(
  scores: T[],
  candidateIds: Set<number>,
): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const s of scores) {
    if (!candidateIds.has(s.id)) continue
    if (seen.has(s.id)) throw new Error(`ranking response repeats candidate id ${s.id}`)
    seen.add(s.id)
    out.push(s)
  }
  const missing = [...candidateIds].filter((id) => !seen.has(id))
  if (missing.length > 0) {
    throw new Error(
      `ranking response is missing ${missing.length} candidate(s): ${missing.slice(0, 10).join(', ')}`,
    )
  }
  return out
}

/**
 * Drops duplicate labels that would hide a story entirely: references to unknown ids, self
 * references, and cycles (A -> B -> A, A -> B -> C -> A, ...). In each cycle the highest-scored
 * member (tie: lowest id) becomes the representative and the rest keep pointing into it. Chains
 * that end at a non-duplicate candidate or a recent topic are left alone.
 */
export function resolveDuplicates<T extends Score>(scores: T[], known: Set<number>): T[] {
  const cleaned = scores.map((s) =>
    s.duplicate_of !== null && (s.duplicate_of === s.id || !known.has(s.duplicate_of))
      ? { ...s, duplicate_of: null }
      : s,
  )
  const byId = new Map(cleaned.map((s) => [s.id, s]))
  const roots = new Set<number>()
  const done = new Set<number>()
  for (const start of cleaned) {
    if (done.has(start.id)) continue
    // Each node has at most one outgoing edge, so revisiting a node within one walk is a cycle.
    const path: number[] = []
    const onPath = new Map<number, number>()
    let cur: Score | undefined = start
    while (cur && !done.has(cur.id) && !onPath.has(cur.id)) {
      onPath.set(cur.id, path.length)
      path.push(cur.id)
      cur = cur.duplicate_of === null ? undefined : byId.get(cur.duplicate_of)
    }
    if (cur && onPath.has(cur.id)) {
      const members = path.slice(onPath.get(cur.id)).map((id) => byId.get(id) as Score)
      const best = members.reduce((a, b) =>
        b.score > a.score || (b.score === a.score && b.id < a.id) ? b : a,
      )
      roots.add(best.id)
    }
    for (const id of path) done.add(id)
  }
  return cleaned.map((s) => (roots.has(s.id) ? { ...s, duplicate_of: null } : s))
}

/** Pick the top `count` non-duplicate topics. A fixed count keeps daily volume stable. */
export function pickTop(scores: Score[], candidateIds: Set<number>, count: number): number[] {
  const picked: number[] = []
  const seen = new Set<number>()
  const ranked = scores
    .filter((s) => candidateIds.has(s.id) && s.duplicate_of === null)
    .sort((a, b) => b.score - a.score)
  for (const s of ranked) {
    if (picked.length >= count) break
    // Defensive: a repeated id must not take two pick slots.
    if (seen.has(s.id)) continue
    seen.add(s.id)
    picked.push(s.id)
  }
  return picked
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
    validateScores(raw, ids),
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
