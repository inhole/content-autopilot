import { query } from '../db/pool.ts'
import type { Campaign } from './types.ts'

export async function loadCampaign(id: number): Promise<Campaign | null> {
  const [row] = await query<Campaign>('select * from campaigns where id = $1', [id])
  return row ?? null
}

export async function campaignIdsByStatus(status: Campaign['status']): Promise<number[]> {
  const rows = await query<{ id: number }>(
    'select id from campaigns where status = $1 order by id',
    [status],
  )
  return rows.map((r) => r.id)
}

/** Records that a worker of `role` is alive; /status shows the last time. */
export async function heartbeat(role: string, now = new Date()): Promise<void> {
  await query(
    `insert into worker_heartbeats (role, seen_at) values ($1, $2)
     on conflict (role) do update set seen_at = excluded.seen_at`,
    [role, now],
  )
}
