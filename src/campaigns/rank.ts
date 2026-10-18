import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate, zonedToUtc } from '../lib/time.ts'
import { chatJson } from '../llm/chat.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import { RANK_SYSTEM, type RankCandidate, type RankHistory, rankUser } from './prompts.ts'
import { type Campaign, competition } from './types.ts'

/** The first collection holds ~475 rows; one prompt per 60 keeps each call small and reliable. */
export const RANK_BATCH_SIZE = 60
const HISTORY_LIMIT = 10

const rankSchema = z.object({
  scores: z.array(
    z.object({
      id: z.number().int(),
      score: z.number().min(0).max(10),
      reason: z.string(),
    }),
  ),
})

type RuleInput = Pick<
  Campaign,
  'title' | 'brand' | 'application_count' | 'recruit_count' | 'apply_deadline' | 'remaining_days'
>

/** Why code alone rules a campaign out (before the LLM sees it), or null to let it through. */
export function ruleSkipReason(c: RuleInput, profile: CampaignProfile, now: Date): string | null {
  const haystack = `${c.title}\n${c.brand ?? ''}`.toLowerCase()
  const hit = profile.excludeKeywords.find((kw) => kw && haystack.includes(kw.toLowerCase()))
  if (hit) return `제외 키워드: ${hit}`

  const brand = c.brand?.toLowerCase()
  const badBrand = brand
    ? profile.excludeBrands.find((b) => b && brand.includes(b.toLowerCase()))
    : undefined
  if (badBrand) return `제외 브랜드: ${c.brand}`

  const ratio = competition(c)
  if (profile.maxCompetition !== undefined && ratio !== null && ratio > profile.maxCompetition) {
    return `경쟁률 ${Math.round(ratio)}:1`
  }

  if (
    (c.remaining_days !== null && c.remaining_days < 0) ||
    (c.apply_deadline && c.apply_deadline.getTime() < now.getTime())
  ) {
    return '모집 마감'
  }
  return null
}

/** How many more campaigns may be shortlisted today. Never negative. */
export function remainingQuota(dailyMax: number, shortlistedToday: number): number {
  return Math.max(0, dailyMax - shortlistedToday)
}

export type Scored = { id: number; score: number; reason: string }

/** Splits candidates into consecutive batches of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Merges scores from several batches: unknown ids are dropped, a repeated id keeps its first
 * score, best score first and ties by lower id. `picked` is the top `count`, `rest` the other
 * scored candidates.
 */
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

/**
 * Campaigns that reached SHORTLISTED or a later pre-apply stage today (KST). There is no column
 * for "when it was shortlisted", so this uses updated_at: shortlisting, the owner's decision and
 * applying all bump it, while list refreshes (collect.ts) deliberately do not. Later stages
 * (SELECTED, DRAFT_REVIEW, POSTED) are left out because they change days after the shortlisting.
 * A campaign shortlisted yesterday and applied today counts today; that only makes the quota
 * slightly more conservative.
 */
async function countShortlistedToday(now: Date): Promise<number> {
  const dayStart = zonedToUtc(localDate(now, config.TZ_NAME), '00:00', config.TZ_NAME)
  const [row] = await query<{ n: number }>(
    `select count(*) as n from campaigns
     where status in ('SHORTLISTED', 'PENDING_REVIEW', 'REJECTED', 'EXPIRED', 'APPLIED')
       and updated_at >= $1`,
    [dayStart],
  )
  return row?.n ?? 0
}

async function loadHistory(): Promise<RankHistory> {
  const applied = await query<{ title: string }>(
    `select title from campaigns
     where status in ('APPLIED', 'SELECTED', 'NOT_SELECTED', 'DRAFT_REVIEW', 'POSTED')
     order by updated_at desc limit $1`,
    [HISTORY_LIMIT],
  )
  const rejected = await query<{ title: string; reason: string | null }>(
    `select title, reject_reason as reason from campaigns
     where status = 'REJECTED' order by updated_at desc limit $1`,
    [HISTORY_LIMIT],
  )
  return { applied, rejected }
}

/**
 * Filters COLLECTED campaigns by rule, scores the rest with the LLM (in batches) and shortlists the
 * best ones up to today's remaining quota. Returns shortlisted ids in score order. Candidates the
 * model leaves out, or all of them when the quota is used up, stay COLLECTED for the next run.
 */
export async function rankCollected(now = new Date()): Promise<number[]> {
  const profile = await loadCampaignProfile()
  const rows = await query<Campaign>(
    "select * from campaigns where status = 'COLLECTED' order by id",
  )
  if (rows.length === 0) return []

  const candidates: Campaign[] = []
  for (const c of rows) {
    const skip = ruleSkipReason(c, profile, now)
    if (skip === null) {
      candidates.push(c)
      continue
    }
    await query(
      `update campaigns set status = 'SKIPPED', skip_reason = $2, updated_at = now()
       where id = $1 and status = 'COLLECTED'`,
      [c.id, skip],
    )
  }
  if (candidates.length === 0) return []

  // Quota used up: leave the rest COLLECTED instead of burning LLM calls.
  const quota = remainingQuota(config.CAMPAIGN_DAILY_MAX, await countShortlistedToday(now))
  if (quota === 0) return []

  const history = await loadHistory()
  const scores: Scored[] = []
  for (const batch of chunk(candidates, RANK_BATCH_SIZE)) {
    const input: RankCandidate[] = batch.map((c) => ({
      id: c.id,
      title: c.title,
      brand: c.brand,
      application_count: c.application_count,
      recruit_count: c.recruit_count,
      remaining_days: c.remaining_days,
    }))
    const out = await chatJson({
      model: config.LLM_RANK_MODEL,
      system: RANK_SYSTEM,
      user: rankUser({ profile, history, candidates: input }),
      schema: rankSchema,
      schemaName: 'campaign_scores',
      temperature: 0.3,
    })
    const batchIds = new Set(batch.map((c) => c.id))
    scores.push(...out.scores.filter((s) => batchIds.has(s.id)))
  }

  const { picked, rest } = pickTopCampaigns(scores, new Set(candidates.map((c) => c.id)), quota)
  const shortlisted: number[] = []
  for (const s of picked) {
    const [row] = await query<{ id: number }>(
      `update campaigns set status = 'SHORTLISTED', score = $2, reason = $3, updated_at = now()
       where id = $1 and status = 'COLLECTED' returning id`,
      [s.id, s.score, s.reason],
    )
    if (row) shortlisted.push(row.id)
  }
  for (const s of rest) {
    await query(
      `update campaigns set status = 'SKIPPED', score = $2, reason = $3, skip_reason = $4,
         updated_at = now()
       where id = $1 and status = 'COLLECTED'`,
      [s.id, s.score, s.reason, `선별 탈락: ${s.reason}`],
    )
  }
  return shortlisted
}
