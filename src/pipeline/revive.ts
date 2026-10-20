import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import { chatJson } from '../llm/openrouter.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'
import { charCount, shortenPrompt } from './generate.ts'
import { PROMPT_VERSION } from './prompts.ts'
import { JUDGE_SYSTEM, judgePrompt, REVIVE_SYSTEM, revivePrompt } from './revive-prompts.ts'

/** Expired drafts older than this are left alone: even evergreen ones lose their hook. */
export const REVIVE_MAX_AGE_DAYS = 30
const LIST_MAX = 20

export type Verdict = 'evergreen' | 'stale'

export type RevivablePost = {
  id: number
  title: string
  text: string
  sourceUrl: string | null
  createdAt: Date
  verdict: Verdict | null
  reason: string | null
  checkedAt: Date | null
}

/** Whole calendar days between two instants, counted on the `tz` calendar. */
export function ageInDays(from: Date, now: Date, tz: string): number {
  const day = (d: Date) => Date.parse(`${localDate(d, tz)}T00:00:00Z`)
  return Math.max(0, Math.round((day(now) - day(from)) / 86_400_000))
}

type Row = {
  id: number
  title: string
  text: string
  source_url: string | null
  created_at: Date
  revive_verdict: Verdict | null
  revive_reason: string | null
  revive_checked_at: Date | null
}

/** EXPIRED news drafts that were neither revived nor folded into a digest, newest first. */
export async function loadRevivable(now: Date = new Date()): Promise<RevivablePost[]> {
  const since = new Date(now.getTime() - REVIVE_MAX_AGE_DAYS * 86_400_000)
  const rows = await query<Row>(
    `select p.id, t.title, p.text, p.source_url, p.created_at,
            p.revive_verdict, p.revive_reason, p.revive_checked_at
     from posts p join topics t on t.id = p.topic_id
     where p.platform = 'THREADS' and p.status = 'EXPIRED' and p.origin = 'news'
       and p.revived_at is null and p.digest_post_id is null and p.created_at >= $1
     order by p.created_at desc, p.id desc
     limit ${LIST_MAX}`,
    [since],
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    text: r.text,
    sourceUrl: r.source_url,
    createdAt: r.created_at,
    verdict: r.revive_verdict,
    reason: r.revive_reason,
    checkedAt: r.revive_checked_at,
  }))
}

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({ id: z.number().int(), verdict: z.enum(['evergreen', 'stale']), reason: z.string() }),
  ),
})

/** Keeps only verdicts for ids that were asked about; the first verdict per id wins. */
export function acceptVerdicts(
  asked: number[],
  verdicts: z.infer<typeof verdictsSchema>['verdicts'],
): Map<number, { verdict: Verdict; reason: string }> {
  const allowed = new Set(asked)
  const out = new Map<number, { verdict: Verdict; reason: string }>()
  for (const v of verdicts) {
    if (allowed.has(v.id) && !out.has(v.id)) {
      out.set(v.id, { verdict: v.verdict, reason: v.reason.trim() })
    }
  }
  return out
}

/**
 * Judges revivable drafts that have no verdict yet with one LLM call and saves the verdicts.
 * Returns all revivable drafts with their (possibly new) verdicts.
 */
export async function judgeExpired(now: Date = new Date()): Promise<RevivablePost[]> {
  const posts = await loadRevivable(now)
  const todo = posts.filter((p) => !p.checkedAt)
  if (!todo.length) return posts

  const tz = config.TZ_NAME
  const result = await chatJson({
    model: config.LLM_RANK_MODEL,
    system: JUDGE_SYSTEM,
    user: judgePrompt(
      todo.map((p) => ({
        id: p.id,
        title: p.title,
        text: p.text,
        ageDays: ageInDays(p.createdAt, now, tz),
      })),
    ),
    schema: verdictsSchema,
    schemaName: 'revive_verdicts',
    temperature: 0,
  })
  const accepted = acceptVerdicts(
    todo.map((p) => p.id),
    result.verdicts,
  )
  for (const [id, v] of accepted) {
    await query(
      `update posts set revive_verdict = $2, revive_reason = $3, revive_checked_at = now()
       where id = $1 and status = 'EXPIRED'`,
      [id, v.verdict, v.reason],
    )
  }
  return posts.map((p) => {
    const v = accepted.get(p.id)
    return v ? { ...p, verdict: v.verdict, reason: v.reason, checkedAt: now } : p
  })
}

const reviveSchema = z.object({
  text: z.string().min(1).max(4000),
  changes: z.array(z.string()),
})

/**
 * Rewrites the time-bound wording of an expired draft and sends it back to PENDING_REVIEW
 * (origin 'revived'). The new text is also stored as generation.text so style learning does not
 * mistake it for an owner edit. Follow-up parts are kept. Returns whether the conditional update
 * applied.
 */
export async function reviveDraft(postId: number, now: Date = new Date()): Promise<boolean> {
  const [post] = await query<{ title: string; text: string; created_at: Date }>(
    `select t.title, p.text, p.created_at from posts p join topics t on t.id = p.topic_id
     where p.id = $1 and p.status = 'EXPIRED' and p.revived_at is null and p.digest_post_id is null`,
    [postId],
  )
  if (!post) return false

  const tz = config.TZ_NAME
  const revived = await chatJson({
    model: config.LLM_MODEL,
    system: REVIVE_SYSTEM,
    user: revivePrompt({
      title: post.title,
      text: post.text,
      createdDate: localDate(post.created_at, tz),
      today: localDate(now, tz),
      ageDays: ageInDays(post.created_at, now, tz),
    }),
    schema: reviveSchema,
    schemaName: 'threads_revived',
    temperature: 0.3,
  })
  let text = revived.text.trim()
  if (charCount(text) > THREADS_TEXT_LIMIT) {
    const shortened = await chatJson({
      model: config.LLM_MODEL,
      system: REVIVE_SYSTEM,
      user: shortenPrompt(text),
      schema: z.object({ text: z.string().min(1).max(THREADS_TEXT_LIMIT) }),
      schemaName: 'threads_post_shortened',
      temperature: 0.3,
    })
    text = shortened.text.trim()
  }

  const patch = JSON.stringify({
    text,
    prompt_version: PROMPT_VERSION,
    revived: { from_text: post.text, changes: revived.changes, at: now.toISOString() },
  })
  const rows = await query<{ id: number }>(
    `update posts set text = $2, generation = coalesce(generation, '{}'::jsonb) || $3::jsonb,
       origin = 'revived', revived_at = now(), status = 'PENDING_REVIEW',
       revision = revision + 1, review_message_id = null, review_revision = null, updated_at = now()
     where id = $1 and status = 'EXPIRED' and revived_at is null and digest_post_id is null
     returning id`,
    [postId, text, patch],
  )
  return rows.length > 0
}
