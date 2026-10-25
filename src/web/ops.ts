import { z } from 'zod'
import { CQ, MAINTENANCE_CRON } from '../campaigns/jobs.ts'
import {
  type CampaignProfile,
  campaignProfileSchema,
  loadProfileInEffect,
  type ProfileInEffect,
  resetCampaignProfile,
  saveCampaignProfile,
} from '../campaigns/profile.ts'
import { chars, disclosureReserve, MIN_BODY_MAX } from '../campaigns/review-draft.ts'
import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { INSIGHTS_CRON, INSIGHTS_QUEUE, Q } from '../jobs.ts'
import {
  envRuntimeSettings,
  loadRuntimeSettings,
  parseDailyCron,
  type RuntimeSettings,
  resetRuntimeSettings,
  saveRuntimeSettings,
} from '../settings.ts'
import type {
  OpsJobName,
  OpsJobState,
  OpsProfileFields,
  OpsProfileResponse,
  OpsResponse,
  OpsScheduleFields,
  OpsScheduleResponse,
  OpsScheduleState,
  OpsScheduleView,
} from './api-types.ts'

/** Jobs the operations page can start by hand: name -> pg-boss queue and schedule. */
export const OPS_JOBS: Record<
  OpsJobName,
  { queue: string; cron: (s: RuntimeSettings) => string | null }
> = {
  'threads-daily': { queue: Q.daily, cron: (s) => s.crons.threadsCollect },
  'gift-collect': { queue: CQ.collect, cron: (s) => s.crons.giftCollect },
  'musinsa-collect': { queue: CQ.musinsaCollect, cron: (s) => s.crons.musinsaCollect },
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

/** The profile as the page shows it; null (and a log line) when it cannot be loaded. */
export async function loadProfileForOps(
  load: () => Promise<ProfileInEffect> = loadProfileInEffect,
): Promise<OpsResponse['profile']> {
  try {
    const { profile: p, source, revision } = await load()
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
      source,
      revision,
    }
  } catch (err) {
    console.error('[ops] campaign profile could not be loaded:', (err as Error).message)
    return null
  }
}

// ---------- schedule editing ----------

const cronView = (cron: string) => ({ cron, daily: parseDailyCron(cron) })

const viewOf = (s: RuntimeSettings): OpsScheduleView => ({
  threadsCollect: cronView(s.crons.threadsCollect),
  giftCollect: cronView(s.crons.giftCollect),
  musinsaCollect: cronView(s.crons.musinsaCollect),
  dailyPostCount: s.dailyPostCount,
  publishSlots: s.publishSlots,
  campaignDailyMax: s.campaignDailyMax,
})

/** The schedule block of GET /api/ops: values in effect, the env defaults, source and revision. */
export function scheduleState(effective: RuntimeSettings): OpsScheduleState {
  return {
    current: viewOf(effective),
    defaults: viewOf(envRuntimeSettings()),
    source: effective.source,
    revision: effective.revision,
  }
}

export type ScheduleEdit = {
  /** Saves an already validated schedule; null when `revision` is stale. */
  save(schedule: OpsScheduleFields, revision: number): Promise<OpsScheduleResponse | null>
  /** Drops the saved copy; null when `revision` is stale. */
  reset(revision: number): Promise<OpsScheduleResponse | null>
}

/**
 * Saves or resets in the database, then re-registers the collect schedules through `apply`
 * (applySchedules, which reads the settings in effect itself). A failed re-registration is logged
 * and reported as `applied: false`; the save stays, and the next worker start registers it.
 */
export function createScheduleEdit(apply: () => Promise<void>): ScheduleEdit {
  const finish = async (): Promise<OpsScheduleResponse> => {
    let applied = true
    try {
      await apply()
    } catch (err) {
      applied = false
      console.error('[ops] schedules could not be re-registered:', (err as Error).message)
    }
    return { ok: true, schedule: scheduleState(await loadRuntimeSettings()), applied }
  }
  return {
    async save(schedule, revision) {
      return (await saveRuntimeSettings(schedule, revision)) === null ? null : finish()
    },
    async reset(revision) {
      return (await resetRuntimeSettings(revision)) ? finish() : null
    },
  }
}

// ---------- profile editing ----------

const ABOUT_MAX = 500
const LINE_MAX = 200
const LIST_MAX = 50
const ITEM_MAX = 50

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => chars(v) <= max, { message: `at most ${max} chars` })

/** Trims items (length checked per submitted index), drops empty ones and duplicates. */
const list = z
  .array(text(ITEM_MAX))
  .transform((items) => [...new Set(items.filter((i) => i !== ''))])
  .refine((items) => items.length <= LIST_MAX, { message: `at most ${LIST_MAX} items` })

const profileFieldsSchema = z
  .object({
    about: text(ABOUT_MAX),
    interests: list,
    preferKeywords: list,
    excludeKeywords: list,
    excludeBrands: list,
    maxCompetition: z.number().positive().nullable(),
    minPriceWon: z.number().int().positive().nullable(),
    review: z.object({
      tone: text(LINE_MAX),
      minChars: z.number().int().min(10),
      maxChars: z.number().int().min(50).max(4000),
      points: list,
    }),
    disclosure: text(LINE_MAX).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.review.minChars >= p.review.maxChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['review', 'minChars'],
        message: 'minChars must be below maxChars',
      })
    }
    // Same reservation as reviewLimits: the disclosure line must leave a body of MIN_BODY_MAX+.
    if (p.review.maxChars - disclosureReserve(p.disclosure) < MIN_BODY_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['disclosure'],
        message: 'the disclosure leaves no room within maxChars',
      })
    }
  })

export type ParsedProfileInput =
  | { ok: true; profile: CampaignProfile }
  | { ok: false; fields: string[] }

const dotted = (issues: { path: PropertyKey[] }[]) => [
  ...new Set(issues.map((i) => i.path.map(String).join('.') || 'profile')),
]

/** Validates a submitted profile; on success returns it as the stored `CampaignProfile`. */
export function parseProfileInput(input: unknown): ParsedProfileInput {
  const parsed = profileFieldsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, fields: dotted(parsed.error.issues) }
  const f: OpsProfileFields = parsed.data
  const stored = campaignProfileSchema.safeParse({
    about: f.about,
    interests: f.interests,
    preferKeywords: f.preferKeywords,
    excludeKeywords: f.excludeKeywords,
    excludeBrands: f.excludeBrands,
    ...(f.maxCompetition === null ? {} : { maxCompetition: f.maxCompetition }),
    ...(f.minPriceWon === null ? {} : { minPriceWon: f.minPriceWon }),
    review: f.review,
    ...(f.disclosure === null || f.disclosure === '' ? {} : { disclosure: f.disclosure }),
  })
  if (!stored.success) return { ok: false, fields: dotted(stored.error.issues) }
  return { ok: true, profile: stored.data }
}

export type ProfileEdit = {
  /** Saves an already validated profile; null when `revision` is stale. */
  save(profile: CampaignProfile, revision: number): Promise<OpsProfileResponse | null>
  /** Drops the saved copy; null when `revision` is stale. */
  reset(revision: number): Promise<OpsProfileResponse | null>
}

/** The profile now in effect after an edit (what GET /api/ops shows). */
async function profileNow(): Promise<OpsProfileResponse> {
  const profile = await loadProfileForOps()
  if (!profile) throw new Error('campaign profile could not be read after the edit')
  return { ok: true, profile }
}

export const dbProfileEdit: ProfileEdit = {
  async save(profile, revision) {
    return (await saveCampaignProfile(profile, revision)) === null ? null : profileNow()
  },
  async reset(revision) {
    return (await resetCampaignProfile(revision)) ? profileNow() : null
  },
}

/** Read-only settings that shape the pipelines (no secrets). */
export function opsSettings(s: RuntimeSettings): OpsResponse['settings'] {
  return {
    dailyPostCount: s.dailyPostCount,
    publishSlots: s.publishSlots,
    threadChainEnabled: config.THREAD_CHAIN_ENABLED,
    threadsDryRun: config.THREADS_DRY_RUN,
    campaignDailyMax: s.campaignDailyMax,
    campaignRankMode: config.CAMPAIGN_RANK_MODE,
    timeZone: config.TZ_NAME,
  }
}

export async function loadOps(
  deps: {
    runs?: (queues: string[]) => Promise<Map<string, QueueRun>>
    profile?: () => Promise<ProfileInEffect>
    settings?: () => Promise<RuntimeSettings>
  } = {},
): Promise<OpsResponse> {
  const names = Object.keys(OPS_JOBS) as OpsJobName[]
  const runs = await (deps.runs ?? loadQueueRuns)(names.map((n) => OPS_JOBS[n].queue))
  const effective = await (deps.settings ?? loadRuntimeSettings)()
  return {
    jobs: names.map((name) => {
      const { queue, cron } = OPS_JOBS[name]
      const run = runs.get(queue)
      return {
        name,
        queue,
        cron: cron(effective),
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
    settings: opsSettings(effective),
    schedule: scheduleState(effective),
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
