import { CQ, MAINTENANCE_CRON } from '../campaigns/jobs.ts'
import { type CampaignProfile, loadCampaignProfile } from '../campaigns/profile.ts'
import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { INSIGHTS_CRON, INSIGHTS_QUEUE, Q } from '../jobs.ts'
import type { OpsJobName, OpsJobState, OpsResponse } from './api-types.ts'

/** Jobs the operations page can start by hand: name -> pg-boss queue and schedule. */
export const OPS_JOBS: Record<OpsJobName, { queue: string; cron: () => string | null }> = {
  'threads-daily': { queue: Q.daily, cron: () => config.COLLECT_CRON },
  'gift-collect': { queue: CQ.collect, cron: () => config.GIFT_COLLECT_CRON },
  'musinsa-collect': { queue: CQ.musinsaCollect, cron: () => config.MUSINSA_COLLECT_CRON },
  'campaign-maintenance': { queue: CQ.maintenance, cron: () => MAINTENANCE_CRON },
  'collect-insights': { queue: INSIGHTS_QUEUE, cron: () => INSIGHTS_CRON },
}

export function parseOpsJobName(name: string): OpsJobName | null {
  return Object.hasOwn(OPS_JOBS, name) ? (name as OpsJobName) : null
}

/** Latest pg-boss job of a queue and whether one is waiting or running. */
export type QueueRun = {
  last: {
    state: OpsJobState
    created_at: Date
    started_at: Date | null
    completed_at: Date | null
    error: string | null
  } | null
  busy: boolean
}

const ERROR_MAX = 300
/** Postgres: undefined_table / invalid_schema_name (pg-boss has not created its schema yet). */
const MISSING_SCHEMA_CODES = new Set(['42P01', '3F000'])

const shorten = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ERROR_MAX ? `${flat.slice(0, ERROR_MAX - 1)}…` : flat
}

/**
 * Reads the pg-boss job table (`pgboss.job`, one row per job, partitioned by queue name). A failed
 * job keeps the serialized error in `output` (`message`, plus a stack that is never read); a
 * non-object output is stored as `{ value }`. Returns empty runs when the schema does not exist.
 */
export async function loadQueueRuns(
  queues: string[],
  q: Query = query,
): Promise<Map<string, QueueRun>> {
  const runs = new Map<string, QueueRun>(queues.map((q) => [q, { last: null, busy: false }]))
  try {
    const latest = await q<{
      name: string
      state: OpsJobState
      created_on: Date
      started_on: Date | null
      completed_on: Date | null
      message: string | null
    }>(
      `select distinct on (name) name, state::text as state, created_on, started_on, completed_on,
              coalesce(output->>'message', output->>'value') as message
         from pgboss.job
        where name = any($1)
        order by name, created_on desc`,
      [queues],
    )
    for (const r of latest) {
      const run = runs.get(r.name)
      if (!run) continue
      run.last = {
        state: r.state,
        created_at: r.created_on,
        started_at: r.started_on,
        completed_at: r.completed_on,
        error: r.state === 'failed' && r.message ? shorten(r.message) : null,
      }
    }
    const busy = await q<{ name: string }>(
      `select distinct name from pgboss.job
        where name = any($1) and state in ('created', 'retry', 'active')`,
      [queues],
    )
    for (const r of busy) {
      const run = runs.get(r.name)
      if (run) run.busy = true
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (!code || !MISSING_SCHEMA_CODES.has(code)) throw err
    console.warn('[ops] pg-boss schema not found yet; showing no runs')
  }
  return runs
}

/** The profile as the page shows it; null (and a log line) when the file cannot be loaded. */
export async function loadProfileForOps(
  load: () => Promise<CampaignProfile> = loadCampaignProfile,
): Promise<OpsResponse['profile']> {
  try {
    const p = await load()
    return {
      about: p.about,
      interests: p.interests,
      preferKeywords: p.preferKeywords,
      excludeKeywords: p.excludeKeywords,
      excludeBrands: p.excludeBrands,
      maxCompetition: p.maxCompetition ?? null,
      minPriceWon: p.minPriceWon ?? null,
      review: {
        tone: p.review.tone,
        minChars: p.review.minChars,
        maxChars: p.review.maxChars,
        points: p.review.points,
      },
      disclosure: p.disclosure ?? null,
    }
  } catch (err) {
    console.error('[ops] campaign profile could not be loaded:', (err as Error).message)
    return null
  }
}

/** Read-only settings that shape the pipelines (no secrets). */
export function opsSettings(): OpsResponse['settings'] {
  return {
    dailyPostCount: config.DAILY_POST_COUNT,
    publishSlots: config.PUBLISH_SLOTS,
    threadChainEnabled: config.THREAD_CHAIN_ENABLED,
    threadsDryRun: config.THREADS_DRY_RUN,
    campaignDailyMax: config.CAMPAIGN_DAILY_MAX,
    campaignRankMode: config.CAMPAIGN_RANK_MODE,
    timeZone: config.TZ_NAME,
  }
}

export async function loadOps(
  deps: {
    runs?: (queues: string[]) => Promise<Map<string, QueueRun>>
    profile?: () => Promise<CampaignProfile>
  } = {},
): Promise<OpsResponse> {
  const names = Object.keys(OPS_JOBS) as OpsJobName[]
  const runs = await (deps.runs ?? loadQueueRuns)(names.map((n) => OPS_JOBS[n].queue))
  return {
    jobs: names.map((name) => {
      const { queue, cron } = OPS_JOBS[name]
      const run = runs.get(queue)
      return {
        name,
        queue,
        cron: cron(),
        last: run?.last
          ? {
              state: run.last.state,
              created_at: run.last.created_at.toISOString(),
              started_at: run.last.started_at?.toISOString() ?? null,
              completed_at: run.last.completed_at?.toISOString() ?? null,
              error: run.last.error,
            }
          : null,
        busy: run?.busy ?? false,
      }
    }),
    settings: opsSettings(),
    profile: await loadProfileForOps(deps.profile),
  }
}

/**
 * Holds a transaction-scoped advisory lock per queue while `fn` runs, so concurrent run requests
 * (two tabs, or two instances during a redeploy) check and send one at a time. pg-boss sends on its
 * own connection and commits before the lock is released, so the next holder sees that job.
 * `fn` reads through the transaction's client: asking the pool for another one while holding a
 * client would exhaust the pool when several requests wait on the lock at once.
 */
const lockQueue = <T>(queue: string, fn: (q: Query) => Promise<T>): Promise<T> =>
  transaction(async (q) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`ops-run:${queue}`])
    return fn(q)
  })

/**
 * Starts a job now. False (nothing sent) when one is already queued or running, or when the queue
 * policy dropped the send (pg-boss answers null for stately/singleton duplicates). The busy check
 * and the send are serialized per queue: the singleton policy alone would queue a second job.
 */
export async function runOpsJob(
  name: OpsJobName,
  deps: {
    runs?: (queues: string[], q: Query) => Promise<Map<string, QueueRun>>
    send: (queue: string) => Promise<string | null>
    lock?: <T>(queue: string, fn: (q: Query) => Promise<T>) => Promise<T>
  },
): Promise<boolean> {
  const { queue } = OPS_JOBS[name]
  return (deps.lock ?? lockQueue)(queue, async (q) => {
    const run = (await (deps.runs ?? loadQueueRuns)([queue], q)).get(queue)
    if (run?.busy) return false
    return (await deps.send(queue)) !== null
  })
}
