import { z } from 'zod'
import { config } from './config.ts'
import { type Query, query } from './db/pool.ts'
import type { DailySchedule, OpsScheduleFields } from './web/api-types.ts'

/** The three schedules the console can edit. */
export type ScheduleKey = 'threadsCollect' | 'giftCollect' | 'musinsaCollect'

// ---------- cron <-> DailySchedule ----------

/** `<minute> <h,h,...> * * *`: the only cron form the console edits. */
export function dailyToCron(d: DailySchedule): string {
  return `${d.minute} ${d.hours.join(',')} * * *`
}

/**
 * Reads a cron string as a DailySchedule when it is exactly the simple daily form (one minute,
 * a comma list of hours, `* * *` for the rest). Anything else (steps, ranges, day-of-week,
 * several minutes) is null: env crons may be anything.
 */
export function parseDailyCron(cron: string): DailySchedule | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hours, dom, month, dow] = parts as [string, string, string, string, string]
  if (dom !== '*' || month !== '*' || dow !== '*') return null
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}(,\d{1,2})*$/.test(hours)) return null
  const m = Number(minute)
  const hs = hours.split(',').map(Number)
  if (m > 59 || hs.some((h) => h > 23)) return null
  return { minute: m, hours: [...new Set(hs)].sort((a, b) => a - b) }
}

// ---------- stored copy ----------

const dailySchema = z.object({
  minute: z.number().int().min(0).max(59),
  hours: z
    .array(z.number().int().min(0).max(23))
    .transform((hs) => [...new Set(hs)].sort((a, b) => a - b))
    .refine((hs) => hs.length >= 1 && hs.length <= 24, { message: 'need 1-24 hours' }),
})

/** `H:MM` or `HH:MM` (trimmed) to zero-padded `HH:MM`; anything else stays as is and fails. */
const slotSchema = z
  .string()
  .transform((s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    return m ? `${(m[1] as string).padStart(2, '0')}:${m[2]}` : s
  })
  .refine((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s), { message: 'expected HH:MM' })

export const scheduleFieldsSchema = z.object({
  threadsCollect: dailySchema,
  giftCollect: dailySchema,
  musinsaCollect: dailySchema,
  dailyPostCount: z.number().int().min(1).max(10),
  publishSlots: z
    .array(slotSchema)
    .transform((s) => [...new Set(s)].sort())
    .refine((s) => s.length >= 1 && s.length <= 10, { message: 'need 1-10 slots' }),
  campaignDailyMax: z.number().int().min(1).max(20),
})

export type ParsedScheduleInput =
  | { ok: true; schedule: OpsScheduleFields }
  | { ok: false; fields: string[] }

/** Validates and normalizes a submitted (or stored) schedule; failures as dotted paths. */
export function parseScheduleInput(input: unknown): ParsedScheduleInput {
  const parsed = scheduleFieldsSchema.safeParse(input)
  if (parsed.success) return { ok: true, schedule: parsed.data }
  const fields = parsed.error.issues.map((i) => i.path.map(String).join('.') || 'schedule')
  return { ok: false, fields: [...new Set(fields)] }
}

// ---------- values in effect ----------

export type RuntimeSettings = {
  /** Cron strings in effect (env strings may be any form). */
  crons: Record<ScheduleKey, string>
  dailyPostCount: number
  publishSlots: string[]
  campaignDailyMax: number
  source: 'db' | 'env'
  /** Edit guard: the row's revision, 0 until the first save. */
  revision: number
}

/** The env values, read from `config` at call time. */
export function envRuntimeSettings(revision = 0): RuntimeSettings {
  return {
    crons: {
      threadsCollect: config.COLLECT_CRON,
      giftCollect: config.GIFT_COLLECT_CRON,
      musinsaCollect: config.MUSINSA_COLLECT_CRON,
    },
    dailyPostCount: config.DAILY_POST_COUNT,
    publishSlots: config.PUBLISH_SLOTS,
    campaignDailyMax: config.CAMPAIGN_DAILY_MAX,
    source: 'env',
    revision,
  }
}

function fromFields(f: OpsScheduleFields, revision: number): RuntimeSettings {
  return {
    crons: {
      threadsCollect: dailyToCron(f.threadsCollect),
      giftCollect: dailyToCron(f.giftCollect),
      musinsaCollect: dailyToCron(f.musinsaCollect),
    },
    dailyPostCount: f.dailyPostCount,
    publishSlots: f.publishSlots,
    campaignDailyMax: f.campaignDailyMax,
    source: 'db',
    revision,
  }
}

/**
 * The schedules and volumes in effect. The saved copy (table `runtime_settings`) is re-read on
 * every call (one single-row select, no cache), so an edit applies from the next run or approval
 * without a restart. No row, a reset copy (null) or one that no longer matches the schema (logged)
 * leaves env in effect, with the row's revision so the page can save over it.
 */
export async function loadRuntimeSettings(q: Query = query): Promise<RuntimeSettings> {
  const [row] = await q<{ settings: unknown; revision: number }>(
    'select settings, revision from runtime_settings where id = 1',
  )
  if (!row) return envRuntimeSettings(0)
  if (row.settings === null) return envRuntimeSettings(row.revision)
  const parsed = parseScheduleInput(row.settings)
  if (parsed.ok) return fromFields(parsed.schedule, row.revision)
  console.error(
    '[settings] saved schedule settings are invalid; using env:',
    parsed.fields.join(','),
  )
  return envRuntimeSettings(row.revision)
}

/**
 * Saves the settings if `revision` is the one the caller saw: 0 = never saved (inserts only while
 * no row exists, giving revision 1), n > 0 = updates the row at revision n to n + 1 (also after a
 * reset, which keeps the row). Returns the new revision, or null when the revision is stale.
 */
export async function saveRuntimeSettings(
  settings: OpsScheduleFields,
  revision: number,
): Promise<number | null> {
  const json = JSON.stringify(settings)
  const rows =
    revision === 0
      ? await query<{ revision: number }>(
          `insert into runtime_settings (id, settings, revision) values (1, $1::jsonb, 1)
           on conflict (id) do nothing returning revision`,
          [json],
        )
      : await query<{ revision: number }>(
          `update runtime_settings set settings = $1::jsonb, revision = revision + 1, updated_at = now()
            where id = 1 and revision = $2 returning revision`,
          [json, revision],
        )
  return rows[0]?.revision ?? null
}

/**
 * Clears the saved copy so env applies again. The row stays and its revision still grows, so a
 * page holding an older revision cannot later match a copy saved after the reset. True when done;
 * false when `revision` is stale. Revision 0 means the page never saw a saved copy: nothing to
 * clear, so true while there still is no row, false if someone saved one meanwhile.
 */
export async function resetRuntimeSettings(revision: number): Promise<boolean> {
  if (revision === 0) {
    const rows = await query('select 1 from runtime_settings where id = 1')
    return rows.length === 0
  }
  const rows = await query(
    `update runtime_settings set settings = null, revision = revision + 1, updated_at = now()
      where id = 1 and revision = $1 returning id`,
    [revision],
  )
  return rows.length > 0
}
