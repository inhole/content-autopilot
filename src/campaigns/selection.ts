import { type BrowserAgent, getBrowserAgent } from '../aside/client.ts'
import { query } from '../db/pool.ts'
import { listMyCampaignIds } from './apply.ts'

/** An unannounced campaign is called lost once its announcement is this far in the past. */
export const NOT_SELECTED_AFTER_DAYS = 2
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Compares the owner's revu 'accepted' list with the APPLIED campaigns. Found there: SELECTED.
 * Announced more than 2 days ago and still absent: NOT_SELECTED. Throws when revu is logged out
 * (the caller alerts), so a logged-out page never reads as "nobody was selected". Every write is
 * conditional on status = 'APPLIED', so a concurrent run or manual change wins.
 */
export async function checkSelections(
  agent: BrowserAgent = getBrowserAgent(),
  now = new Date(),
): Promise<{ selected: number[]; notSelected: number[] }> {
  const accepted = await listMyCampaignIds(agent, 'accepted')
  const applied = await query<{ id: number; external_id: string; announce_at: Date | null }>(
    "select id, external_id, announce_at from campaigns where status = 'APPLIED' order by id",
  )
  const selected: number[] = []
  const notSelected: number[] = []
  const cutoff = now.getTime() - NOT_SELECTED_AFTER_DAYS * DAY_MS
  for (const c of applied) {
    if (accepted.has(c.external_id)) {
      const rows = await query(
        `update campaigns set status = 'SELECTED', selected_at = $2, updated_at = now()
         where id = $1 and status = 'APPLIED' returning id`,
        [c.id, now],
      )
      if (rows.length > 0) selected.push(c.id)
    } else if (c.announce_at && c.announce_at.getTime() < cutoff) {
      const rows = await query(
        `update campaigns set status = 'NOT_SELECTED', updated_at = now()
         where id = $1 and status = 'APPLIED' returning id`,
        [c.id],
      )
      if (rows.length > 0) notSelected.push(c.id)
    }
  }
  return { selected, notSelected }
}
