import type { PgBoss } from 'pg-boss'
import { config } from './config.ts'
import { transaction } from './db/pool.ts'
import { loadRuntimeSettings, type ScheduleKey } from './settings.ts'

/** Which pg-boss queue each editable schedule belongs to (callers pass the ones they own). */
export type ScheduleTargets = Partial<Record<ScheduleKey, string>>

/**
 * Registers the given queues' cron schedules from the settings in effect. pg-boss keeps schedules
 * in its own table, so one call updates every instance. The settings are read inside a
 * transaction-scoped advisory lock, never taken from a request: two concurrent saves then end with
 * the newest crons registered, whichever applies last. The settings are read through the
 * transaction's client and pg-boss uses its own connections, so a request waiting on the lock
 * never needs a second pool client (the pool has 5).
 */
export function applySchedules(boss: PgBoss, targets: ScheduleTargets): Promise<void> {
  return transaction(async (q) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', ['ops-schedule'])
    const { crons } = await loadRuntimeSettings(q)
    for (const [key, queue] of Object.entries(targets) as [ScheduleKey, string][]) {
      await boss.schedule(queue, crons[key], null, { tz: config.TZ_NAME })
    }
  })
}
