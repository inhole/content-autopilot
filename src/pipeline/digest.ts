import { z } from 'zod'
import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import { chatJson } from '../llm/openrouter.ts'
import { THREADS_TEXT_LIMIT } from '../threads/client.ts'
import { DIGEST_RULES, type DigestPromptItem, digestUserPrompt } from './digest-prompts.ts'
import { charCount, type Generation, shortenPrompt } from './generate.ts'
import { lastFollowupLimit, loadParts, MAX_FOLLOWUPS, replaceParts } from './parts.ts'
import { GENERATE_SYSTEM } from './prompts.ts'

// The weekly "이번 주 놓친 소식" chain (docs/plans/roadmap.md 1): EXPIRED news drafts that were not
// revived are folded into one chain post. Item 1 is the main post, items 2 and 3 are follow-ups,
// each carrying its own source link (post_parts.link_url). A member post is used at most once
// (posts.digest_post_id).

/** Main post + MAX_FOLLOWUPS follow-ups, the chain maximum. */
export const DIGEST_ITEMS = 1 + MAX_FOLLOWUPS
/** A digest needs at least this many items to be worth a chain. */
export const MIN_DIGEST_ITEMS = 2
/** Expired drafts older than this are no longer "this week's" news. */
export const DIGEST_WINDOW_DAYS = 10

export type DigestCandidate = {
  postId: number
  title: string
  text: string
  sourceUrl: string | null
  score: number | null
  createdAt: Date
}

/** Highest topic score first (unscored last), then newest; at most `limit` items. */
export function pickDigestItems(
  candidates: DigestCandidate[],
  limit = DIGEST_ITEMS,
): DigestCandidate[] {
  return [...candidates]
    .sort(
      (a, b) =>
        (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.postId - a.postId,
    )
    .slice(0, limit)
}

type CandidateRow = {
  id: number
  title: string
  text: string
  source_url: string | null
  score: number | null
  created_at: Date
}

const toCandidate = (r: CandidateRow): DigestCandidate => ({
  postId: r.id,
  title: r.title,
  text: r.text,
  sourceUrl: r.source_url,
  score: r.score,
  createdAt: r.created_at,
})

/**
 * Expired news drafts that can still go into a digest: not revived, not already in a digest,
 * created within DIGEST_WINDOW_DAYS, and not judged evergreen (those are kept for individual
 * revival). Ordered like pickDigestItems.
 */
export async function loadDigestCandidates(now = new Date()): Promise<DigestCandidate[]> {
  const rows = await query<CandidateRow>(
    `select p.id, t.title, p.text, p.source_url, t.score, p.created_at
     from posts p join topics t on t.id = p.topic_id
     where p.platform = 'THREADS' and p.status = 'EXPIRED' and p.origin = 'news'
       and p.revived_at is null and p.digest_post_id is null
       and p.created_at > $1::timestamptz - make_interval(days => $2)
       and (p.revive_verdict is null or p.revive_verdict = 'stale')`,
    [now, DIGEST_WINDOW_DAYS],
  )
  return pickDigestItems(rows.map(toCandidate), rows.length)
}

const digestDraftSchema = z.object({
  text: z.string().min(50).max(4000),
  followups: z.array(z.string().max(4000)),
  angle: z.string(),
  topic_tag: z.string().max(50),
  caveats: z.array(z.string()),
})
const shortenSchema = (limit: number) => z.object({ text: z.string().min(1).max(limit) })
const SHORTEN_MARGIN = 50
const DIGEST_SYSTEM = `${GENERATE_SYSTEM}\n\n${DIGEST_RULES}`

/**
 * One LLM call for the digest chain over `items` (in order). The follow-up count must equal
 * items - 1; every piece over its limit is shortened once, the last follow-up to leave room for
 * the CTA appended at publish time.
 */
export async function draftDigest(
  items: DigestPromptItem[],
  revision?: { previous: string[]; feedback?: string | undefined },
  model = config.LLM_MODEL,
): Promise<Generation> {
  const raw = await chatJson({
    model,
    system: DIGEST_SYSTEM,
    user: digestUserPrompt(items, revision),
    schema: digestDraftSchema,
    schemaName: 'weekly_digest',
  })
  const followups = raw.followups.map((f) => f.trim()).filter(Boolean)
  if (followups.length !== items.length - 1) {
    throw new Error(
      `digest needs ${items.length - 1} follow-ups, the model wrote ${followups.length}`,
    )
  }
  const fitTo = async (text: string, limit: number): Promise<string> => {
    if (charCount(text) <= limit) return text
    const shortened = await chatJson({
      model,
      system: DIGEST_SYSTEM,
      user: shortenPrompt(text, limit - SHORTEN_MARGIN),
      schema: shortenSchema(limit),
      schemaName: 'weekly_digest_shortened',
      temperature: 0.3,
    })
    return shortened.text
  }
  const lastIdx = followups.length - 1
  return {
    ...raw,
    text: await fitTo(raw.text, THREADS_TEXT_LIMIT),
    followups: await Promise.all(
      followups.map((f, i) =>
        fitTo(f, i === lastIdx ? lastFollowupLimit(config.THREAD_CTA_TEXT) : THREADS_TEXT_LIMIT),
      ),
    ),
  }
}

class ClaimShortfall extends Error {}

/**
 * Builds this week's digest from the best expired drafts and leaves it PENDING_REVIEW. Returns
 * the new post id, or null when there are fewer than MIN_DIGEST_ITEMS usable drafts (or another
 * build took some of them meanwhile).
 */
export async function buildWeeklyDigest(now = new Date()): Promise<number | null> {
  const items = (await loadDigestCandidates(now)).slice(0, DIGEST_ITEMS)
  if (items.length < MIN_DIGEST_ITEMS) return null

  const gen = await draftDigest(items.map(toPromptItem))
  const followupItems = items.slice(1)
  const meta = { member_post_ids: items.map((i) => i.postId), built_at: now.toISOString() }
  const title = `이번 주 놓친 소식 (${localDate(now, config.TZ_NAME)})`

  try {
    return await transaction(async (q: Query) => {
      const [topic] = await q<{ id: number }>(
        `insert into topics (source_id, title, url, status)
         values ((select id from sources where kind = 'MANUAL' limit 1), $1, null, 'USED')
         returning id`,
        [title],
      )
      if (!topic) throw new Error('failed to insert the digest topic')
      const [post] = await q<{ id: number }>(
        `insert into posts (topic_id, text, angle, source_url, generation, status, origin)
         values ($1, $2, $3, $4, $5, 'PENDING_REVIEW', 'digest')
         returning id`,
        [
          topic.id,
          gen.text,
          gen.angle,
          items[0]?.sourceUrl ?? null,
          JSON.stringify({ ...gen, digest: meta }),
        ],
      )
      if (!post) throw new Error('failed to insert the digest post')
      // The text covers every item, so all of them must be claimed; a concurrent build that got
      // there first makes this one roll back (its row lock serializes the two updates).
      const claimed = await q<{ id: number }>(
        `update posts set digest_post_id = $1, updated_at = now()
         where id = any($2::bigint[]) and status = 'EXPIRED' and revived_at is null
           and digest_post_id is null
         returning id`,
        [post.id, meta.member_post_ids],
      )
      if (claimed.length < items.length) throw new ClaimShortfall()
      await replaceParts(
        q,
        post.id,
        gen.followups,
        followupItems.map((i) => i.sourceUrl),
      )
      return post.id
    })
  } catch (err) {
    if (err instanceof ClaimShortfall) return null
    throw err
  }
}

const toPromptItem = (c: DigestCandidate): DigestPromptItem => ({
  title: c.title,
  text: c.text,
  sourceUrl: c.sourceUrl,
})

/** The digest post (not the topic) behind a topic, if the topic belongs to one. */
export async function digestPostIdForTopic(topicId: number): Promise<number | null> {
  const [row] = await query<{ id: number }>(
    "select id from posts where topic_id = $1 and platform = 'THREADS' and origin = 'digest'",
    [topicId],
  )
  return row?.id ?? null
}

export type RegenerateDigestOptions = {
  feedback?: string | undefined
  /** `posts.regen_seq` of the request; the write is dropped if a newer request exists. */
  seq?: number | undefined
}

/**
 * Rewrites a digest under review from its same member posts, with the previous text and the
 * feedback in the prompt. Writes only while the post is still PENDING_REVIEW (and `regen_seq`
 * still equals `seq` when given); the parts keep their links. Returns the post id, or null when
 * nothing was written.
 */
export async function regenerateDigest(
  postId: number,
  options: RegenerateDigestOptions = {},
): Promise<number | null> {
  const [post] = await query<{
    text: string
    generation: { digest?: { member_post_ids?: number[] } }
  }>(
    `select text, generation from posts
     where id = $1 and origin = 'digest' and status = 'PENDING_REVIEW'`,
    [postId],
  )
  if (!post) return null
  const memberIds = post.generation?.digest?.member_post_ids ?? []
  const rows = await query<CandidateRow>(
    `select p.id, t.title, p.text, p.source_url, t.score, p.created_at
     from posts p join topics t on t.id = p.topic_id
     where p.digest_post_id = $1`,
    [postId],
  )
  const byId = new Map(rows.map((r) => [r.id, toCandidate(r)]))
  const members = memberIds.flatMap((id) => byId.get(id) ?? [])
  if (members.length < MIN_DIGEST_ITEMS || members.length !== memberIds.length) {
    throw new Error(`digest #${postId}: member posts are missing`)
  }

  const previousParts = await loadParts(postId)
  const gen = await draftDigest(members.map(toPromptItem), {
    previous: [post.text, ...previousParts.map((p) => p.text)],
    feedback: options.feedback,
  })

  return transaction(async (q: Query) => {
    const [row] = await q<{ id: number }>(
      `update posts set text = $2, angle = $3,
         generation = $4::jsonb || jsonb_build_object('digest', generation->'digest'),
         revision = revision + 1, updated_at = now()
       where id = $1 and status = 'PENDING_REVIEW' and ($5::int is null or regen_seq = $5)
       returning id`,
      [postId, gen.text, gen.angle, JSON.stringify(gen), options.seq ?? null],
    )
    if (!row) return null
    await replaceParts(
      q,
      postId,
      gen.followups,
      members.slice(1).map((m) => m.sourceUrl),
    )
    return row.id
  })
}
