import { z } from 'zod'
import { type BrowserAgent, getBrowserAgent } from '../aside/client.ts'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import { chatJson } from '../llm/openrouter.ts'
import { DETAIL_SYSTEM, detailUser } from './prompts.ts'
import { loadCampaign } from './store.ts'
import { type CampaignDetail, campaignDetailSchema } from './types.ts'

/** A failure worth retrying (browser timeout, LLM hiccup). */
export class TransientCampaignError extends Error {}
/** The page cannot be turned into a campaign; retrying will not help. */
export class UnreadableCampaignError extends Error {}

const PAGE_TEXT_MAX = 15_000
const MIN_PAGE_CHARS = 200
// A login wall or an error page is short; a real campaign page is longer than this.
const WALL_MAX_CHARS = 800

/** Why a page cannot be a campaign page, or null when it looks readable. */
export function unreadableReason(text: string): string | null {
  const t = text.trim()
  if (t.length < MIN_PAGE_CHARS) return `page text too short (${t.length} chars)`
  if (t.length < WALL_MAX_CHARS) {
    if (/로그인|회원가입/.test(t) && !/모집|신청/.test(t)) return 'login wall'
    if (/찾을 수 없|존재하지 않|삭제된|종료된 캠페인|404/.test(t)) return 'campaign not found'
  }
  return null
}

const toDate = (iso: string | null): Date | null => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Column values for the DETAILED update; unparseable dates become null. */
export function detailToColumns(detail: CampaignDetail) {
  return {
    title: detail.title,
    type: detail.type,
    category: detail.category,
    reward_won: detail.rewardWon,
    recruit_count: detail.recruitCount,
    apply_deadline: toDate(detail.applyDeadline),
    announce_at: toDate(detail.announceAt),
    review_deadline: toDate(detail.reviewDeadline),
    keywords: detail.keywords,
  }
}

async function markUnreadable(id: number, reason: string): Promise<void> {
  await query(
    `update campaigns set status = 'UNREADABLE', last_error = $2, updated_at = now()
     where id = $1 and status = 'DISCOVERED'`,
    [id, reason],
  )
}

/**
 * Reads a DISCOVERED campaign's revu page and stores the structured detail. 'unreadable' is final
 * (no retry); aside and LLM failures throw TransientCampaignError so the job retries.
 */
export async function fetchCampaignDetail(
  campaignId: number,
  agent: BrowserAgent = getBrowserAgent(),
): Promise<'detailed' | 'unreadable' | 'not-pending'> {
  const c = await loadCampaign(campaignId)
  if (c?.status !== 'DISCOVERED') return 'not-pending'

  let text: string
  try {
    text = (await agent.readPage(c.url)).text
  } catch (err) {
    throw new TransientCampaignError(`read ${c.url}: ${(err as Error).message}`, { cause: err })
  }
  const reason = unreadableReason(text)
  if (reason) {
    await markUnreadable(c.id, reason)
    return 'unreadable'
  }

  let detail: CampaignDetail
  try {
    detail = await chatJson({
      model: config.LLM_RANK_MODEL,
      system: DETAIL_SYSTEM,
      user: detailUser(text.slice(0, PAGE_TEXT_MAX), localDate(new Date(), config.TZ_NAME)),
      schema: campaignDetailSchema,
      schemaName: 'campaign_detail',
      temperature: 0,
    })
  } catch (err) {
    // Schema failures and provider errors alike: the job's retry limit decides when to stop.
    const msg =
      err instanceof z.ZodError ? 'detail extraction failed validation' : (err as Error).message
    throw new TransientCampaignError(msg, { cause: err })
  }

  const col = detailToColumns(detail)
  const updated = await query(
    `update campaigns set status = 'DETAILED', title = $2, type = $3, category = $4,
       reward_won = $5, recruit_count = $6, apply_deadline = $7, announce_at = $8,
       review_deadline = $9, keywords = $10, detail = $11, last_error = null, updated_at = now()
     where id = $1 and status = 'DISCOVERED' returning id`,
    [
      c.id,
      col.title,
      col.type,
      col.category,
      col.reward_won,
      col.recruit_count,
      col.apply_deadline,
      col.announce_at,
      col.review_deadline,
      col.keywords,
      JSON.stringify(detail),
    ],
  )
  return updated.length > 0 ? 'detailed' : 'not-pending'
}
