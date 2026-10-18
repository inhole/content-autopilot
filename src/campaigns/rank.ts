import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate, zonedToUtc } from '../lib/time.ts'
import { chatJson } from '../llm/openrouter.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import {
  RANK_SYSTEM,
  type RankCandidate,
  type RankHistory,
  REWRITE_SYSTEM,
  rankUser,
  rewriteUser,
  SHORTEN_SYSTEM,
  shortenApplyPrompt,
} from './prompts.ts'
import { loadCampaign } from './store.ts'
import type { Campaign } from './types.ts'

const MAX_CANDIDATES = 50
const HISTORY_LIMIT = 10
// Asking for slightly fewer characters than the limit leaves room for the model's miscounting.
const SHORTEN_MARGIN = 20

const chars = (s: string) => [...s].length

const rankSchema = z.object({
  scores: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().min(0).max(10),
      reason: z.string(),
      applyMessage: z.string(),
    }),
  ),
})

type RuleInput = Pick<
  Campaign,
  'type' | 'reward_won' | 'apply_deadline' | 'title' | 'detail' | 'category'
>

const TYPE_LABEL = { delivery: '배송형', visit: '방문형', other: '기타' } as const

/** Why code alone rules a campaign out (before the LLM sees it), or null to let it through. */
export function ruleSkipReason(c: RuleInput, profile: CampaignProfile, now: Date): string | null {
  if (c.type && !profile.types.includes(c.type)) return `유형: ${TYPE_LABEL[c.type]}`

  const haystack = [c.title, c.category, c.detail?.offer, c.detail?.guide]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  const hit = profile.excludeKeywords.find((kw) => kw && haystack.includes(kw.toLowerCase()))
  if (hit) return `제외 키워드: ${hit}`

  if (c.reward_won !== null && c.reward_won < profile.minRewardWon) return '제공 가치 낮음'
  if (c.apply_deadline && c.apply_deadline.getTime() < now.getTime()) return '신청 마감 지남'

  const channel = c.detail?.channel
  if (channel && !/블로그|blog/i.test(channel)) return `채널: ${channel}`
  return null
}

/** How many more campaigns may reach review today. Never negative. */
export function remainingQuota(dailyMax: number, reviewedToday: number): number {
  return Math.max(0, dailyMax - reviewedToday)
}

type Scored = { id: number; score: number; reason: string; applyMessage: string }

/** Keeps known candidates once each (first wins), best score first, ties by lower id. */
export function pickTopCampaigns(scores: Scored[], candidateIds: Set<number>, count: number) {
  const seen = new Set<number>()
  const known: Scored[] = []
  for (const s of scores) {
    if (!candidateIds.has(s.id) || seen.has(s.id)) continue
    seen.add(s.id)
    known.push(s)
  }
  known.sort((a, b) => b.score - a.score || a.id - b.id)
  return { picked: known.slice(0, count), rest: known.slice(count) }
}

/** Cuts at the last sentence end that keeps at least half the limit; else hard-cuts with an ellipsis. */
export function truncateAtSentence(text: string, max: number): string {
  const all = [...text.trim()]
  if (all.length <= max) return all.join('')
  const head = all.slice(0, max)
  for (let i = head.length - 1; i >= Math.floor(max / 2); i--) {
    if (/[.!?。…\n]/.test(head[i] ?? ''))
      return head
        .slice(0, i + 1)
        .join('')
        .trim()
  }
  return `${head
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

/**
 * Brings an apply message within `max` characters: one LLM shortening pass, then a sentence-boundary
 * truncation, because providers do not enforce lengths.
 */
export async function fitApplyMessage(text: string, max: number): Promise<string> {
  const t = text.trim()
  if (chars(t) <= max) return t
  try {
    const out = await chatJson({
      model: config.LLM_RANK_MODEL,
      system: SHORTEN_SYSTEM,
      user: shortenApplyPrompt(t, Math.max(1, max - SHORTEN_MARGIN)),
      schema: z.object({ text: z.string().min(1) }),
      schemaName: 'apply_message_shortened',
      temperature: 0,
    })
    if (chars(out.text.trim()) <= max) return out.text.trim()
    return truncateAtSentence(out.text, max)
  } catch {
    return truncateAtSentence(t, max)
  }
}

/** Campaigns that reached owner review today (KST), or are already queued for it. */
async function countReviewedToday(now: Date): Promise<number> {
  const dayStart = zonedToUtc(localDate(now, config.TZ_NAME), '00:00', config.TZ_NAME)
  // Only stages up to the apply: later ones (SELECTED, ...) change days after the review.
  const [row] = await query<{ n: number }>(
    `select count(*) as n from campaigns
     where status in ('SHORTLISTED', 'PENDING_REVIEW', 'REJECTED', 'APPROVED', 'APPLYING',
                      'APPLIED', 'APPLY_FAILED')
       and updated_at >= $1`,
    [dayStart],
  )
  return row?.n ?? 0
}

async function loadHistory(): Promise<RankHistory> {
  const accepted = await query<{ title: string; category: string | null }>(
    `select title, category from campaigns
     where status in ('APPROVED', 'APPLYING', 'APPLIED', 'SELECTED', 'RECEIVED', 'POSTED')
       and title is not null
     order by updated_at desc limit $1`,
    [HISTORY_LIMIT],
  )
  const rejected = await query<{ title: string; category: string | null; reason: string | null }>(
    `select title, category, reject_reason as reason from campaigns
     where status = 'REJECTED' and title is not null
     order by updated_at desc limit $1`,
    [HISTORY_LIMIT],
  )
  return { accepted, rejected }
}

/**
 * Filters DETAILED campaigns by rule, scores the rest in one LLM call (which also drafts the apply
 * message) and shortlists the best ones up to today's remaining quota. Returns shortlisted ids in
 * score order. Candidates the model leaves out stay DETAILED for the next run.
 */
export async function rankDetailed(now = new Date()): Promise<number[]> {
  const profile = await loadCampaignProfile()
  const rows = await query<Campaign>(
    "select * from campaigns where status = 'DETAILED' order by id limit $1",
    [MAX_CANDIDATES],
  )
  if (rows.length === 0) return []

  const remaining: Campaign[] = []
  for (const c of rows) {
    const skip = ruleSkipReason(c, profile, now)
    if (skip === null) {
      remaining.push(c)
      continue
    }
    await query(
      `update campaigns set status = 'SKIPPED', skip_reason = $2, updated_at = now()
       where id = $1 and status = 'DETAILED'`,
      [c.id, skip],
    )
  }
  if (remaining.length === 0) return []

  // Quota used up: leave the rest DETAILED for tomorrow instead of burning an LLM call.
  const quota = remainingQuota(config.CAMPAIGN_DAILY_MAX, await countReviewedToday(now))
  if (quota === 0) return []

  const candidates: RankCandidate[] = remaining.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    detail: c.detail,
  }))
  const { scores } = await chatJson({
    model: config.LLM_RANK_MODEL,
    system: RANK_SYSTEM,
    user: rankUser({ profile, history: await loadHistory(), candidates }),
    schema: rankSchema,
    schemaName: 'campaign_scores',
    temperature: 0.3,
  })

  const { picked, rest } = pickTopCampaigns(scores, new Set(remaining.map((c) => c.id)), quota)

  const shortlisted: number[] = []
  for (const s of picked) {
    const message = await fitApplyMessage(s.applyMessage, profile.applyMessage.maxChars)
    const done = await query(
      `update campaigns set status = 'SHORTLISTED', score = $2, reason = $3, apply_message = $4,
         updated_at = now()
       where id = $1 and status = 'DETAILED' returning id`,
      [s.id, s.score, s.reason, message],
    )
    if (done.length > 0) shortlisted.push(s.id)
  }
  for (const s of rest) {
    await query(
      `update campaigns set status = 'SKIPPED', score = $2, reason = $3, skip_reason = $4,
         updated_at = now()
       where id = $1 and status = 'DETAILED'`,
      [s.id, s.score, s.reason, `선별 탈락: ${s.reason}`],
    )
  }
  return shortlisted
}

/**
 * Regenerates only the apply message of a PENDING_REVIEW campaign from the owner's feedback.
 * Written only if the revision is still the one read before the LLM call, so a verbatim edit made
 * meanwhile wins. Returns whether anything was written.
 */
export async function rewriteApplyMessage(campaignId: number, feedback: string): Promise<boolean> {
  const c = await loadCampaign(campaignId)
  if (c?.status !== 'PENDING_REVIEW' || !c.apply_message) return false
  const profile = await loadCampaignProfile()
  const max = profile.applyMessage.maxChars

  const out = await chatJson({
    model: config.LLM_RANK_MODEL,
    system: REWRITE_SYSTEM,
    user: rewriteUser({
      profile,
      candidate: { id: c.id, title: c.title, category: c.category, detail: c.detail },
      current: c.apply_message,
      feedback,
    }),
    schema: z.object({ applyMessage: z.string().min(1) }),
    schemaName: 'apply_message_rewrite',
    temperature: 0.3,
  })
  const message = await fitApplyMessage(out.applyMessage, max)
  const done = await query(
    `update campaigns set apply_message = $3, revision = revision + 1, updated_at = now()
     where id = $1 and status = 'PENDING_REVIEW' and revision = $2 returning id`,
    [c.id, c.revision, message],
  )
  return done.length > 0
}
