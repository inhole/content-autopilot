import { config } from '../config.ts'
import { type Query, query } from '../db/pool.ts'
import { type TextPost, THREADS_TEXT_LIMIT } from '../threads/client.ts'

// Thread chains (docs/decisions.md 8). The main post (posts.text) is part 1; its follow-ups live
// in post_parts as parts 2..(1 + MAX_FOLLOWUPS), each published as a reply to the previous part.

/** Most follow-up replies a chain can have. */
export const MAX_FOLLOWUPS = 2
/** `post_parts.idx` of the first follow-up. */
export const FIRST_FOLLOWUP_IDX = 2

export type PartStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED'

export type PostPart = {
  idx: number
  text: string
  status: PartStatus
  container_id: string | null
  platform_post_id: string | null
  attempts: number
  claim_seq: number
  last_error: string | null
}

const length = (text: string) => [...text].length

/** What gets appended to the last follow-up: a blank line and the CTA, or nothing. */
export function ctaSuffix(cta: string | undefined = config.THREAD_CTA_TEXT): string {
  return cta ? `\n\n${cta}` : ''
}

/** Character budget for the text of the last follow-up, leaving room for the CTA. */
export function lastFollowupLimit(cta: string | undefined = config.THREAD_CTA_TEXT): number {
  return THREADS_TEXT_LIMIT - length(ctaSuffix(cta))
}

/** A chain post as it goes out; `replyToId` is filled in by the publisher. */
export type ChainPost = Omit<TextPost, 'replyToId'>

/**
 * The posts that go out, in publish order. With follow-ups the source link moves to the last one
 * and the CTA is appended to it; a single post keeps the link and never gets the CTA. The topic
 * tag stays on the main post. If the CTA no longer fits (THREAD_CTA_TEXT changed after review),
 * it is dropped rather than failing the publish.
 */
export function composeChain(input: {
  text: string
  topicTag: string | null
  sourceUrl: string | null
  followups: string[]
  cta?: string | undefined
}): ChainPost[] {
  const cta = 'cta' in input ? input.cta : config.THREAD_CTA_TEXT
  const main: ChainPost = { text: input.text, topicTag: input.topicTag }
  if (input.followups.length === 0) return [{ ...main, linkAttachment: input.sourceUrl }]
  const parts: ChainPost[] = input.followups.map((text) => ({ text }))
  const last = parts[parts.length - 1] as ChainPost
  const withCta = `${last.text}${ctaSuffix(cta)}`
  last.text = length(withCta) <= THREADS_TEXT_LIMIT ? withCta : last.text
  last.linkAttachment = input.sourceUrl
  return [main, ...parts]
}

/** Follow-up parts of a post, in order. */
export async function loadParts(postId: number, q: Query = query): Promise<PostPart[]> {
  return q<PostPart>(
    `select idx, text, status, container_id, platform_post_id, attempts, claim_seq, last_error
     from post_parts where post_id = $1 order by idx`,
    [postId],
  )
}

/**
 * Replaces all follow-ups of a draft with `texts` (renumbered from FIRST_FOLLOWUP_IDX). Only for
 * drafts under review: published parts must never be rewritten. Run it in the same transaction as
 * the posts update it belongs to, so text and parts cannot drift apart.
 */
export async function replaceParts(q: Query, postId: number, texts: string[]): Promise<void> {
  if (texts.length > MAX_FOLLOWUPS) {
    throw new Error(`a chain has at most ${MAX_FOLLOWUPS} follow-ups, got ${texts.length}`)
  }
  await q('delete from post_parts where post_id = $1', [postId])
  if (texts.length === 0) return
  await q(
    `insert into post_parts (post_id, idx, text)
     select $1, $3 + ord::int - 1, t from unnest($2::text[]) with ordinality as u(t, ord)`,
    [postId, texts, FIRST_FOLLOWUP_IDX],
  )
}

/**
 * Puts a published post's FAILED parts back to PENDING with a fresh attempt budget, so the next
 * publish-due sweep picks the chain up again. Returns how many parts were reset.
 */
export async function retryFailedParts(postId: number): Promise<number> {
  const rows = await query(
    `update post_parts pp set status = 'PENDING', attempts = 0, last_error = null,
       alerted_at = null, updated_at = now()
     from posts p
     where p.id = pp.post_id and pp.post_id = $1 and pp.status = 'FAILED'
       and p.status = 'PUBLISHED'
     returning pp.idx`,
    [postId],
  )
  return rows.length
}
