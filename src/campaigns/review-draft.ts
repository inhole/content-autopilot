import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import {
  expandReviewPrompt,
  type ReviewLimits,
  reviewSystem,
  reviewUser,
  shortenReviewPrompt,
} from './review-prompts.ts'
import { loadCampaign } from './store.ts'
import { musinsaFacts } from './types.ts'

/**
 * Gift review drafts (docs/plans/campaign-autopilot.md): the owner's memo in, a short review text
 * out. Every transition is a conditional UPDATE, like src/campaigns/review.ts.
 */

const ACTIVE = "status in ('SELECTED', 'DRAFT_REVIEW')"
const DISCLOSURE_GAP = '\n\n'

export const chars = (s: string) => [...s].length

const draftSchema = z.object({ text: z.string().min(1) })

// ---------- pure helpers ----------

/** Body limits that leave room for the disclosure line within review.maxChars. */
export function reviewLimits(profile: CampaignProfile): ReviewLimits {
  const { minChars, maxChars } = profile.review
  const reserve = profile.disclosure ? chars(profile.disclosure) + DISCLOSURE_GAP.length : 0
  const max = Math.max(10, maxChars - reserve)
  const min = Math.min(Math.max(1, minChars - reserve), max)
  return { min, max }
}

const squash = (s: string) => s.replace(/[\s[\]()（）【】]/g, '')
const DISCLOSURE_WORDS = /광고|협찬|제공받|제공 받|원고료|체험단|소정의/

/** True when a first line looks like a sponsorship notice the model added on its own. */
function looksLikeDisclosure(line: string, disclosure: string): boolean {
  const a = squash(line)
  const b = squash(disclosure)
  if (!a) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  return chars(line) <= 60 && DISCLOSURE_WORDS.test(line)
}

/** The full review text: disclosure first (set by code, never the model), then the body. */
export function composeReview(profile: CampaignProfile, body: string): string {
  const text = body.trim()
  const disclosure = profile.disclosure
  if (!disclosure) return text
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const rest = looksLikeDisclosure(first, disclosure) ? lines.slice(1).join('\n').trim() : text
  return rest ? `${disclosure}${DISCLOSURE_GAP}${rest}` : disclosure
}

/** Cuts at the last sentence end within max chars; hard cut when there is none. */
export function cutAtSentence(text: string, max: number): string {
  const all = [...text]
  if (all.length <= max) return text
  const head = all.slice(0, max).join('')
  const end = Math.max(
    head.lastIndexOf('.'),
    head.lastIndexOf('!'),
    head.lastIndexOf('?'),
    head.lastIndexOf('\n'),
    head.lastIndexOf('요'),
    head.lastIndexOf('다'),
  )
  const cut = end >= Math.floor(max / 2) ? head.slice(0, end + 1) : head
  return cut.trim()
}

// ---------- generation ----------

/**
 * Registers a draft (re)generation request and returns its sequence number, or null when the
 * campaign is not at the stage of writing a review. Only the latest request's result is kept.
 */
export async function requestDraftRegeneration(id: number): Promise<number | null> {
  const [row] = await query<{ regen_seq: number }>(
    `update campaigns set regen_seq = regen_seq + 1, updated_at = now()
     where id = $1 and ${ACTIVE}
     returning regen_seq`,
    [id],
  )
  return row?.regen_seq ?? null
}

/** One LLM body, shortened/expanded once if outside the limits, cut at a sentence as last resort. */
export async function draftBody(
  system: string,
  user: string,
  memo: string,
  limits: ReviewLimits,
): Promise<string> {
  const call = async (u: string, schemaName: string) =>
    (
      await chatJson({
        model: config.LLM_MODEL,
        system,
        user: u,
        schema: draftSchema,
        schemaName,
      })
    ).text.trim()
  let body = await call(user, 'campaign_review_draft')
  if (chars(body) > limits.max) {
    body = await call(shortenReviewPrompt(body, limits.max - 10), 'campaign_review_shortened')
    if (chars(body) > limits.max) body = cutAtSentence(body, limits.max)
  } else if (chars(body) < limits.min) {
    const longer = await call(
      expandReviewPrompt(body, memo, limits.min, limits.max),
      'campaign_review_expanded',
    )
    // Keep the short original rather than an over-long or shorter rewrite; the card shows the count.
    if (chars(longer) > chars(body) && chars(longer) <= limits.max) body = longer
  }
  return body
}

/**
 * Writes the review draft from the owner's memo and leaves the campaign DRAFT_REVIEW. Returns
 * false when nothing was written: no memo, wrong status, or a newer request superseded `seq`.
 */
export async function generateReviewDraft(
  id: number,
  opts: { feedback?: string; seq?: number } = {},
): Promise<boolean> {
  const c = await loadCampaign(id)
  if (!c?.memo?.trim() || (c.status !== 'SELECTED' && c.status !== 'DRAFT_REVIEW')) {
    return false
  }
  const profile = await loadCampaignProfile()
  const limits = reviewLimits(profile)
  const body = await draftBody(
    reviewSystem(profile, limits, {
      source: c.source,
      contentType: musinsaFacts(c)?.contentType ?? null,
    }),
    reviewUser(c, { feedback: opts.feedback, previous: c.draft_text }),
    c.memo,
    limits,
  )
  const rows = await query(
    `update campaigns set draft_text = $2, status = 'DRAFT_REVIEW', revision = revision + 1,
       updated_at = now()
     where id = $1 and ${ACTIVE} and memo = $3 and ($4::int is null or regen_seq = $4)
     returning id`,
    [id, composeReview(profile, body), c.memo, opts.seq ?? null],
  )
  return rows.length > 0
}

// ---------- state transitions ----------

/** The intake message the owner replies to with a memo. */
export async function startIntake(id: number, messageId: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set intake_message_id = $2, updated_at = now()
     where id = $1 and ${ACTIVE} returning id`,
    [id, messageId],
  )
  return rows.length > 0
}

export async function saveMemo(id: number, memo: string): Promise<boolean> {
  const text = memo.trim()
  if (!text) return false
  const rows = await query(
    `update campaigns set memo = $2, updated_at = now() where id = $1 and ${ACTIVE} returning id`,
    [id, text],
  )
  return rows.length > 0
}

/** Registers a freshly sent control message, only if the draft it shows is still current. */
export async function markControlSent(
  id: number,
  chatId: number,
  messageId: number,
  revision: number,
): Promise<boolean> {
  const rows = await query(
    `update campaigns set review_chat_id = $2, review_message_id = $3, review_revision = $4,
       updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' and revision = $4 returning id`,
    [id, chatId, messageId, revision],
  )
  return rows.length > 0
}

export type ReplaceDraftResult = { ok: true; revision: number } | { ok: false; message: string }

/**
 * Replaces the draft verbatim (a `수정:` reply to the control message). The disclosure line stays
 * first. Bumps revision so the old control message's buttons stop working until a new one is sent.
 */
export async function replaceDraft(
  id: number,
  reviewMessageId: number,
  text: string,
  profile?: CampaignProfile,
): Promise<ReplaceDraftResult> {
  const next = text.trim()
  if (!next) return { ok: false, message: '리뷰가 비어 있어요. 수정: 뒤에 내용을 적어주세요.' }
  const p = profile ?? (await loadCampaignProfile())
  const full = composeReview(p, next)
  const length = chars(full)
  if (length > p.review.maxChars) {
    return {
      ok: false,
      message: `리뷰가 ${length}자예요. ${p.review.maxChars}자 이하로 줄여주세요.`,
    }
  }
  const [row] = await query<{ revision: number }>(
    // regen_seq moves too, so a regeneration queued before this edit cannot overwrite it.
    `update campaigns set draft_text = $3, revision = revision + 1, regen_seq = regen_seq + 1,
       updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' and review_message_id = $2
     returning revision`,
    [id, reviewMessageId, full],
  )
  if (!row) return { ok: false, message: '이미 처리됐거나 최신 초안 메시지가 아니에요.' }
  return { ok: true, revision: row.revision }
}

/** The owner pasted the review into the shop's review form. Bound to the control message they saw. */
export async function markPosted(id: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'POSTED', posted_at = now(), updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' and revision = $2 and review_revision = $2
     returning id`,
    [id, revision],
  )
  return rows.length > 0
}
