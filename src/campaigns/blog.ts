import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { chatJson } from '../llm/openrouter.ts'
import { BLOG_SYSTEM, buildBlogUserPrompt } from './blog-prompts.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import { loadCampaign } from './store.ts'

export const blogDraftSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(100),
  usedKeywords: z.array(z.string()),
})
export type BlogDraft = z.infer<typeof blogDraftSchema>

const DRAFTABLE = ['RECEIVED', 'SELECTED', 'DRAFT_REVIEW']

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '')

/** Keywords that do not appear in the text (case and spacing insensitive). */
export function findMissingKeywords(text: string, keywords: string[]): string[] {
  const haystack = normalize(text)
  return keywords.filter((k) => k.trim() && !haystack.includes(normalize(k)))
}

// A first paragraph that reads like an ad disclosure: short, and it mentions both the provision
// or program and the fact that the text is a review.
const DISCLOSURE_HINT = /(제공\s*받|협찬|체험단|원고료|소정의|광고|지원\s*받)/
const REVIEW_HINT = /(후기|리뷰|포스팅|작성|글)/

function isDisclosureLike(paragraph: string, disclosure: string): boolean {
  const p = paragraph.trim()
  if (!p) return true
  if (normalize(p) === normalize(disclosure)) return true
  return p.length <= 200 && DISCLOSURE_HINT.test(p) && REVIEW_HINT.test(p)
}

/** Drops disclosure-like paragraphs the model wrote at the top anyway. */
export function stripLeadingDisclosure(body: string, disclosure: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/)
  let dropped = 0
  while (paragraphs.length > 1 && dropped < 2) {
    const first = paragraphs[0] ?? ''
    if (!isDisclosureLike(first, disclosure)) break
    paragraphs.shift()
    dropped++
  }
  return paragraphs.join('\n\n').trim()
}

/** Disclosure first (by code, never the LLM), then the body with placeholders intact. */
export function composeBlogBody(profile: CampaignProfile, draft: { body: string }): string {
  return `${profile.disclosure}\n\n${stripLeadingDisclosure(draft.body, profile.disclosure)}`
}

/** Appends `[사진n]` lines the model forgot, so every photo gets uploaded somewhere. */
export function ensurePhotoPlaceholders(body: string, photoCount: number): string {
  const missing: string[] = []
  for (let n = 1; n <= photoCount; n++) {
    if (!body.includes(`[사진${n}]`)) missing.push(`[사진${n}]`)
  }
  return missing.length ? `${body.trimEnd()}\n\n${missing.join('\n\n')}` : body
}

export const charCount = (text: string) => [...text].length

async function photoCount(campaignId: number): Promise<number> {
  const [row] = await query<{ n: number }>(
    'select count(*)::int as n from campaign_photos where campaign_id = $1',
    [campaignId],
  )
  return row?.n ?? 0
}

/**
 * Registers a regeneration request and returns its sequence number, or null when the campaign
 * has no draft under review. Only the latest request's result is kept (see generateBlogDraft).
 */
export async function requestDraftRegeneration(campaignId: number): Promise<number | null> {
  const [row] = await query<{ regen_seq: number }>(
    `update campaigns set regen_seq = regen_seq + 1, updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' returning regen_seq`,
    [campaignId],
  )
  return row?.regen_seq ?? null
}

/**
 * Writes the blog draft for a campaign and leaves it DRAFT_REVIEW with a new revision. Returns
 * false when nothing was written: the campaign moved on, or `seq` is no longer the latest
 * regeneration request (a retried older request must not clobber a newer result).
 */
export async function generateBlogDraft(
  campaignId: number,
  opts: { feedback?: string; seq?: number } = {},
): Promise<boolean> {
  const c = await loadCampaign(campaignId)
  if (!c || !DRAFTABLE.includes(c.status)) return false
  if (!c.detail) throw new Error(`campaign ${campaignId} has no detail`)
  if (opts.seq !== undefined && c.regen_seq !== opts.seq) return false

  const profile = await loadCampaignProfile()
  const photos = await photoCount(campaignId)
  const keywords = c.detail.keywords.length ? c.detail.keywords : c.keywords
  const base = {
    detail: c.detail,
    keywords,
    profile,
    memo: c.memo ?? '',
    photoCount: photos,
    previousBody: c.status === 'DRAFT_REVIEW' ? c.draft_body : null,
    feedback: opts.feedback,
  }
  const ask = (missingKeywords?: string[]) =>
    chatJson({
      model: config.LLM_MODEL,
      system: BLOG_SYSTEM,
      user: buildBlogUserPrompt({ ...base, missingKeywords }),
      schema: blogDraftSchema,
      schemaName: 'blog_review_draft',
    })

  let draft = await ask()
  const missing = findMissingKeywords(draft.body, keywords)
  if (missing.length) {
    const second = await ask(missing)
    if (findMissingKeywords(second.body, keywords).length <= missing.length) draft = second
  }

  const body = ensurePhotoPlaceholders(composeBlogBody(profile, draft), photos)
  const rows = await query(
    `update campaigns set draft_title = $2, draft_body = $3, status = 'DRAFT_REVIEW',
            revision = revision + 1, updated_at = now()
     where id = $1 and status = any($4::text[]) and ($5::int is null or regen_seq = $5)
     returning id`,
    [campaignId, draft.title.trim(), body, DRAFTABLE, opts.seq ?? null],
  )
  return rows.length > 0
}

/** SELECTED → RECEIVED (the product arrived). False when not SELECTED. */
export async function markReceived(id: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'RECEIVED', received_at = now(), updated_at = now()
     where id = $1 and status = 'SELECTED' returning id`,
    [id],
  )
  return rows.length > 0
}

/** Remembers the intake message photos and the memo are sent as replies to. */
export async function startIntake(id: number, messageId: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set intake_message_id = $2, updated_at = now()
     where id = $1 and status in ('SELECTED', 'RECEIVED') returning id`,
    [id, messageId],
  )
  return rows.length > 0
}

/**
 * Stores one photo (the largest size the caller picked). Returns false for a photo already
 * stored (same file_unique_id) or a campaign past drafting. Media-group photos arrive as
 * concurrent messages, so a clash on idx retries with the next free one.
 */
export async function addPhoto(id: number, fileId: string, fileUniqueId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const rows = await query(
        `insert into campaign_photos (campaign_id, idx, file_id, file_unique_id)
         select c.id, coalesce((select max(idx) from campaign_photos where campaign_id = c.id), 0) + 1,
                $2, $3
         from campaigns c
         where c.id = $1 and c.status in ('SELECTED', 'RECEIVED', 'DRAFT_REVIEW')
           and not exists (select 1 from campaign_photos
                           where campaign_id = c.id and file_unique_id = $3)
         returning idx`,
        [id, fileId, fileUniqueId],
      )
      return rows.length > 0
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err
    }
  }
  throw new Error(`could not store photo for campaign ${id}`)
}

export async function saveMemo(id: number, memo: string): Promise<boolean> {
  const rows = await query(
    `update campaigns set memo = $2, updated_at = now()
     where id = $1 and status in ('SELECTED', 'RECEIVED', 'DRAFT_REVIEW') returning id`,
    [id, memo.trim()],
  )
  return rows.length > 0
}

/**
 * Owner edit of the draft, applied verbatim. Conditioned on status and the card's message id so
 * it cannot race an approval or a newer draft. A new body keeps the disclosure first.
 */
export async function replaceDraft(
  id: number,
  reviewMessageId: number,
  edit: { title?: string; body?: string },
): Promise<boolean> {
  let body: string | null = null
  if (edit.body !== undefined) {
    body = composeBlogBody(await loadCampaignProfile(), { body: edit.body })
  }
  const rows = await query(
    `update campaigns set draft_title = coalesce($3, draft_title),
            draft_body = coalesce($4, draft_body), revision = revision + 1, updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' and review_message_id = $2 returning id`,
    [id, reviewMessageId, edit.title?.trim() || null, body],
  )
  return rows.length > 0
}

/** The owner approved the card they saw (`revision`); the local worker then saves the draft. */
export async function approveDraft(id: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'DRAFT_APPROVED', attempts = 0, last_error = null,
            updated_at = now()
     where id = $1 and status = 'DRAFT_REVIEW' and revision = $2 and draft_body is not null
     returning id`,
    [id, revision],
  )
  return rows.length > 0
}

export async function retryDraftSave(id: number): Promise<boolean> {
  const rows = await query(
    `update campaigns set status = 'DRAFT_APPROVED', attempts = 0, last_error = null,
            updated_at = now()
     where id = $1 and status = 'DRAFT_FAILED' returning id`,
    [id],
  )
  return rows.length > 0
}

/** Returns the URL when it is a Naver blog address (blog.naver.com or m.blog.naver.com). */
export function parseBlogUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'blog.naver.com' && url.hostname !== 'm.blog.naver.com') return null
  return url.toString()
}

/** DRAFT_SAVED → POSTED. Throws on a non-Naver-blog URL; false when not DRAFT_SAVED. */
export async function markPosted(id: number, url: string): Promise<boolean> {
  const blogUrl = parseBlogUrl(url)
  if (!blogUrl) throw new Error('blog.naver.com 주소가 아니에요.')
  const rows = await query(
    `update campaigns set status = 'POSTED', blog_url = $2, posted_at = now(), updated_at = now()
     where id = $1 and status = 'DRAFT_SAVED' returning id`,
    [id, blogUrl],
  )
  return rows.length > 0
}
