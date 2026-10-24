import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate, zonedToUtc } from '../lib/time.ts'
import { chatJson } from '../llm/openrouter.ts'
import { type CampaignProfile, loadCampaignProfile } from './profile.ts'
import { type RankCandidate, type RankHistory, rankSystem, rankUser } from './prompts.ts'
import {
  type Campaign,
  campaignPrice,
  campaignPriceInfo,
  competition,
  musinsaCategoryLabel,
  musinsaFacts,
} from './types.ts'

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
> &
  Partial<Pick<Campaign, 'source' | 'detail'>>

/**
 * A gift campaign whose price fetch has not been tried yet (fillGiftPrices reads at most a capped
 * number per run). Ranking it now would apply neither the price rule nor the price preference, and
 * ranking is final, so it waits COLLECTED for a later run. A failed fetch (`priceTriedAt`) or a
 * row without a product id is ranked with an unknown price.
 */
export function awaitingPrice(c: Pick<Campaign, 'source' | 'product_id' | 'detail'>): boolean {
  if (c.source !== 'kakao-gift' || c.product_id == null) return false
  const detail = (c.detail ?? {}) as Record<string, unknown>
  return !('price' in detail) && !('priceTriedAt' in detail)
}

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

  const price = campaignPrice(c)
  if (profile.minPriceWon !== undefined && price !== null && price < profile.minPriceWon) {
    return `가격 낮음: ${price.toLocaleString('en-US')}원`
  }

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

// Rule score (0-10): competition 5, list price 3, owner preference 2 points.
const COMPETITION_POINTS = 5
const PRICE_POINTS = 3
const PREFER_POINTS = 2
/**
 * 1:1 or better earns full competition points, this many applicants per slot or more none. On
 * 2026-10-24 gift ran 18:1 to 2,466:1 (median 693) and Musinsa about 50:1 to 2,200:1, so a lower
 * floor would flatten most candidates to 0.
 */
const COMPETITION_FLOOR = 3000
/** List prices earn price points on a log scale between these (won). */
const PRICE_LOW = 10_000
const PRICE_HIGH = 300_000

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

type ScoreInput = Pick<
  Campaign,
  'id' | 'source' | 'title' | 'brand' | 'application_count' | 'recruit_count' | 'detail'
>

/**
 * Scores a campaign in code: fewer applicants per slot, a higher list price and a hit on the
 * profile's interests or preferKeywords score higher. Unknown competition or price gets half or
 * a third of its points, so missing data neither wins nor loses outright.
 */
export function ruleScore(c: ScoreInput, profile: CampaignProfile): Scored {
  const reasons: string[] = []

  const ratio = competition(c)
  let points = COMPETITION_POINTS / 2
  if (ratio === null) {
    reasons.push('경쟁률 모름')
  } else {
    points =
      COMPETITION_POINTS *
      clamp01(1 - Math.log10(Math.max(ratio, 1)) / Math.log10(COMPETITION_FLOOR))
    reasons.push(`경쟁률 ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}:1`)
  }

  const price = campaignPrice(c)
  if (price === null) {
    points += PRICE_POINTS / 3
    reasons.push('정가 모름')
  } else {
    points +=
      PRICE_POINTS * clamp01(Math.log10(price / PRICE_LOW) / Math.log10(PRICE_HIGH / PRICE_LOW))
    reasons.push(`정가 ${price.toLocaleString('en-US')}원`)
  }

  const category = musinsaFacts(c)?.category
  const haystack = [c.title, c.brand, category && musinsaCategoryLabel(category)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  const liked = [...profile.preferKeywords, ...profile.interests].find(
    (kw) => kw && haystack.includes(kw.toLowerCase()),
  )
  if (liked) {
    points += PREFER_POINTS
    reasons.push(`관심 ${liked}`)
  }

  return { id: c.id, score: Math.round(points * 10) / 10, reason: reasons.join(' · ') }
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
 * Campaigns picked today (KST), per source. Counted by shortlisted_at (migration 015), not
 * updated_at: maintenance expiring never-picked campaigns also bumps updated_at.
 */
async function countShortlistedToday(now: Date): Promise<Map<string, number>> {
  const dayStart = zonedToUtc(localDate(now, config.TZ_NAME), '00:00', config.TZ_NAME)
  const rows = await query<{ source: string; n: number }>(
    `select source, count(*) as n from campaigns
     where shortlisted_at >= $1
     group by source`,
    [dayStart],
  )
  return new Map(rows.map((r) => [r.source, Number(r.n)]))
}

/** The facts of one campaign the rank prompt shows; Musinsa adds category, price and goods count. */
export function toRankCandidate(c: Campaign): RankCandidate {
  const m = musinsaFacts(c)
  const p = campaignPriceInfo(c)
  return {
    id: c.id,
    source: c.source,
    title: c.title,
    brand: c.brand,
    application_count: c.application_count,
    recruit_count: c.recruit_count,
    remaining_days: c.remaining_days,
    price: p.price,
    sale_price: p.salePrice,
    ...(m ? { category: m.category, goods_count: m.goodsCount } : {}),
  }
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
 * Filters COLLECTED campaigns by rule, scores the rest (`ruleScore`, or the LLM in batches when
 * CAMPAIGN_RANK_MODE is `llm`) and shortlists the best ones up to today's remaining quota. Returns
 * shortlisted ids in score order. Candidates the model leaves out, or all of them when the quota is
 * used up, stay COLLECTED for the next run, and so do gift campaigns still awaiting their price
 * (`awaitingPrice`).
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
      if (!awaitingPrice(c)) candidates.push(c)
      continue
    }
    await query(
      `update campaigns set status = 'SKIPPED', skip_reason = $2, updated_at = now()
       where id = $1 and status = 'COLLECTED'`,
      [c.id, skip],
    )
  }
  if (candidates.length === 0) return []

  // Each source has its own daily quota and its own LLM batches.
  const history = config.CAMPAIGN_RANK_MODE === 'llm' ? await loadHistory() : null
  const doneToday = await countShortlistedToday(now)
  const shortlisted: number[] = []
  for (const source of [...new Set(candidates.map((c) => c.source))]) {
    const ofSource = candidates.filter((c) => c.source === source)
    // Quota used up: leave the rest COLLECTED instead of burning LLM calls.
    const quota = remainingQuota(config.CAMPAIGN_DAILY_MAX, doneToday.get(source) ?? 0)
    if (quota === 0) continue
    shortlisted.push(...(await rankSource(source, ofSource, quota, history, profile)))
  }
  return shortlisted
}

/** Scores one source's candidates and shortlists the top `quota`. Without history, by rule. */
async function rankSource(
  source: string,
  candidates: Campaign[],
  quota: number,
  history: RankHistory | null,
  profile: CampaignProfile,
): Promise<number[]> {
  const scores = history
    ? await llmScores(source, candidates, history, profile)
    : candidates.map((c) => ruleScore(c, profile))
  const { picked, rest } = pickTopCampaigns(scores, new Set(candidates.map((c) => c.id)), quota)
  const shortlisted: number[] = []
  for (const s of picked) {
    const [row] = await query<{ id: number }>(
      `update campaigns set status = 'SHORTLISTED', score = $2, reason = $3,
         shortlisted_at = now(), updated_at = now()
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

/** Scores one source's candidates with the LLM, RANK_BATCH_SIZE per call. */
async function llmScores(
  source: string,
  candidates: Campaign[],
  history: RankHistory,
  profile: CampaignProfile,
): Promise<Scored[]> {
  const scores: Scored[] = []
  for (const batch of chunk(candidates, RANK_BATCH_SIZE)) {
    const out = await chatJson({
      model: config.LLM_RANK_MODEL,
      system: rankSystem(source),
      user: rankUser({ profile, history, candidates: batch.map(toRankCandidate) }),
      schema: rankSchema,
      schemaName: 'campaign_scores',
      temperature: 0.3,
    })
    const batchIds = new Set(batch.map((c) => c.id))
    scores.push(...out.scores.filter((s) => batchIds.has(s.id)))
  }
  return scores
}
