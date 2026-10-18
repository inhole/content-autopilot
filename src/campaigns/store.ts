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
