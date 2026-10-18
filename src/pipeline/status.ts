import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'

const KEY_INFO_URL = 'https://openrouter.ai/api/v1/key'
const KEY_INFO_TIMEOUT_MS = 5_000

const keyInfoSchema = z.object({
  data: z.object({
    usage: z.number().optional(),
    usage_monthly: z.number().optional(),
    limit: z.number().nullish(),
    limit_remaining: z.number().nullish(),
  }),
})

export type LlmCost = {
  usd: number
  /** 'month' when OpenRouter reports usage_monthly; otherwise the key's all-time usage. */
  period: 'month' | 'total'
  limitRemaining?: number
}

/** Maps the OpenRouter key-info response to a cost; null when it carries no usage figure. */
export function parseLlmCost(json: unknown): LlmCost | null {
  const parsed = keyInfoSchema.safeParse(json)
  if (!parsed.success) return null
  const { usage, usage_monthly, limit_remaining } = parsed.data.data
  const usd = usage_monthly ?? usage
  if (usd === undefined) return null
  return {
    usd,
    period: usage_monthly !== undefined ? 'month' : 'total',
    limitRemaining: limit_remaining ?? undefined,
  }
}

/** Best effort: any failure (no key, network, timeout, bad shape) just omits the cost line. */
export async function fetchLlmCost(
  apiKey = config.OPENROUTER_API_KEY,
  fetchFn: typeof fetch = fetch,
): Promise<LlmCost | null> {
  if (!apiKey) return null
  try {
    const res = await fetchFn(KEY_INFO_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(KEY_INFO_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return parseLlmCost(await res.json())
  } catch {
    return null
  }
}

export type Status = {
  expiredLast7d: number
  /** Absent when the OpenRouter key info could not be fetched. */
  llmCost?: LlmCost
  pendingReview: { count: number; ids: number[] }
  scheduled: { id: number; scheduledAt: Date; preview: string }[]
  publishedLast24h: number
  failed: { id: number; lastError: string | null }[]
  /** Follow-up parts of published posts that need attention (see loadChainParts). */
  chainParts: { failed: number; stuck: number }
  threads: { dryRun: boolean; tokenExpiresAt: Date | null }
  /** Absent when pg-boss could not be queried or has no run yet. */
  lastDaily?: { state: string; at: Date }
  campaigns: CampaignCounts
}

export type CampaignCounts = {
  /** Newest last_seen_at of any campaign; null when nothing was ever collected. */
  lastCollectedAt: Date | null
  pendingReview: number
  applied: number
  selected: number
  draftReview: number
  postedLast30d: number
}

export async function loadCampaignCounts(now = new Date()): Promise<CampaignCounts> {
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000)
  const [row] = await query<{
    last_collected_at: Date | null
    pending_review: number
    applied: number
    selected: number
    draft_review: number
    posted_30d: number
  }>(
    `select max(last_seen_at) as last_collected_at,
            count(*) filter (where status = 'PENDING_REVIEW') as pending_review,
            count(*) filter (where status = 'APPLIED') as applied,
            count(*) filter (where status = 'SELECTED') as selected,
            count(*) filter (where status = 'DRAFT_REVIEW') as draft_review,
            count(*) filter (where status = 'POSTED'
                               and coalesce(posted_at, updated_at) >= $1) as posted_30d
       from campaigns`,
    [monthAgo],
  )
  return {
    lastCollectedAt: row?.last_collected_at ?? null,
    pendingReview: row?.pending_review ?? 0,
    applied: row?.applied ?? 0,
    selected: row?.selected ?? 0,
    draftReview: row?.draft_review ?? 0,
    postedLast30d: row?.posted_30d ?? 0,
  }
}

/** Unfinished parts that have not moved for this long are reported as stuck. */
const CHAIN_STUCK_MINUTES = 30

/** Counts FAILED parts, and PENDING/PUBLISHING parts of published posts that stopped moving. */
export async function loadChainParts(now = new Date()): Promise<Status['chainParts']> {
  const staleBefore = new Date(now.getTime() - CHAIN_STUCK_MINUTES * 60_000)
  const [row] = await query<{ failed: number; stuck: number }>(
    `select count(*) filter (where pp.status = 'FAILED') as failed,
            count(*) filter (where pp.status in ('PENDING', 'PUBLISHING')
                               and p.status = 'PUBLISHED' and pp.updated_at < $1) as stuck
     from post_parts pp join posts p on p.id = pp.post_id`,
    [staleBefore],
  )
  return { failed: row?.failed ?? 0, stuck: row?.stuck ?? 0 }
}

const SCHEDULED_SHOWN = 5
const FAILED_SHOWN = 5

export async function loadStatus(now = new Date()): Promise<Status> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  const [pending, scheduled, published, failed, account, expired, llmCost, chainParts, campaigns] =
    await Promise.all([
      query<{ id: number }>("select id from posts where status = 'PENDING_REVIEW' order by id"),
      query<{ id: number; scheduled_at: Date; text: string }>(
        `select id, scheduled_at, left(text, 30) as text from posts
       where status = 'SCHEDULED' order by scheduled_at limit $1`,
        [SCHEDULED_SHOWN],
      ),
      query<{ n: number }>(
        "select count(*) as n from posts where status = 'PUBLISHED' and published_at >= $1",
        [since],
      ),
      query<{ id: number; last_error: string | null }>(
        "select id, last_error from posts where status = 'FAILED' order by id desc limit $1",
        [FAILED_SHOWN],
      ),
      query<{ expires_at: Date | null }>(
        "select expires_at from platform_accounts where platform = 'THREADS'",
      ),
      query<{ n: number }>(
        "select count(*) as n from posts where status = 'EXPIRED' and updated_at >= $1",
        [weekAgo],
      ),
      fetchLlmCost(),
      loadChainParts(now),
      loadCampaignCounts(now),
    ])

  // pg-boss internals may change between versions, so this is best-effort.
  let lastDaily: Status['lastDaily']
  try {
    const [job] = await query<{ state: string; created_on: Date; completed_on: Date | null }>(
      `select state, created_on, completed_on from pgboss.job
       where name = 'daily-pipeline' order by created_on desc limit 1`,
    )
    if (job) lastDaily = { state: job.state, at: job.completed_on ?? job.created_on }
  } catch (err) {
    console.warn('[status] could not read pg-boss job state', err)
  }

  return {
    pendingReview: { count: pending.length, ids: pending.map((p) => p.id) },
    scheduled: scheduled.map((p) => ({
      id: p.id,
      scheduledAt: p.scheduled_at,
      preview: p.text.replace(/\s+/g, ' '),
    })),
    publishedLast24h: published[0]?.n ?? 0,
    failed: failed.map((p) => ({ id: p.id, lastError: p.last_error })),
    threads: { dryRun: config.THREADS_DRY_RUN, tokenExpiresAt: account[0]?.expires_at ?? null },
    chainParts,
    lastDaily,
    expiredLast7d: expired[0]?.n ?? 0,
    llmCost: llmCost ?? undefined,
    campaigns,
  }
}

function fmt(date: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const g = (t: string) => p.find((x) => x.type === t)?.value
  return `${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Compact plain-text report for Telegram; times are shown in `timeZone`. */
export function formatStatus(status: Status, timeZone: string): string {
  const lines = ['📊 현황']
  lines.push(`Threads: ${status.threads.dryRun ? 'DRY-RUN' : '실제 발행'}`)
  const exp = status.threads.tokenExpiresAt
  lines.push(`토큰 만료: ${exp ? fmt(exp, timeZone) : '정보 없음'}`)
  if (status.lastDaily) {
    lines.push(`마지막 수집: ${fmt(status.lastDaily.at, timeZone)} (${status.lastDaily.state})`)
  }
  const { count, ids } = status.pendingReview
  lines.push(`검수 대기: ${count}건${count ? ` (${ids.map((i) => `#${i}`).join(', ')})` : ''}`)
  lines.push(`최근 24시간 발행: ${status.publishedLast24h}건`)
  if (status.scheduled.length) {
    lines.push('발행 예정:')
    for (const p of status.scheduled) {
      lines.push(`- #${p.id} ${fmt(p.scheduledAt, timeZone)} ${truncate(p.preview, 30)}`)
    }
  } else {
    lines.push('발행 예정: 없음')
  }
  if (status.failed.length) {
    lines.push('실패:')
    for (const p of status.failed) {
      lines.push(`- #${p.id} ${truncate((p.lastError ?? '원인 미상').replace(/\s+/g, ' '), 80)}`)
    }
  }
  const { failed: partsFailed, stuck: partsStuck } = status.chainParts
  if (partsFailed > 0) {
    lines.push(`연결 글 답글 실패: ${partsFailed}건 (Telegram 알림의 재시도 버튼 사용)`)
  }
  if (partsStuck > 0) lines.push(`연결 글 답글 멈춤: ${partsStuck}건 (30분 넘게 진행 없음)`)
  if (status.expiredLast7d > 0) lines.push(`최근 7일 만료: ${status.expiredLast7d}건`)
  if (status.llmCost) {
    const { usd, period, limitRemaining } = status.llmCost
    const label = period === 'month' ? '이번 달 LLM 비용' : 'LLM 누적 비용'
    lines.push(
      `${label}: $${usd.toFixed(2)}${limitRemaining != null ? ` (한도 잔여 $${limitRemaining.toFixed(2)})` : ''}`,
    )
  }
  const c = status.campaigns
  const campaignLines = [
    ['검수 대기', c.pendingReview],
    ['신청함·결과 대기', c.applied],
    ['선정·리뷰 전', c.selected],
    ['리뷰 초안', c.draftReview],
    ['최근 30일 리뷰 완료', c.postedLast30d],
  ] as const
  lines.push('', '🎁 체험단')
  lines.push(
    `체험단 마지막 수집: ${c.lastCollectedAt ? fmt(c.lastCollectedAt, timeZone) : '기록 없음'}`,
  )
  for (const [label, n] of campaignLines) if (n > 0) lines.push(`${label}: ${n}건`)
  return lines.join('\n')
}
