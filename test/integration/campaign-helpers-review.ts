import type { Campaign } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

let seq = 0

/** Inserts a campaign row; `over` maps column names to values. */
export async function seedCampaign(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1
  const row: Record<string, unknown> = {
    external_id: `rv-${seq}-${Date.now()}`,
    url: `https://www.revu.net/campaign/${seq}`,
    url_hash: `hash-${seq}-${Date.now()}`,
    status: 'PENDING_REVIEW',
    title: `campaign ${seq}`,
    apply_message: '안녕하세요, 정성껏 후기를 남기겠습니다.',
    ...over,
  }
  const cols = Object.keys(row)
  const [res] = await query<{ id: number }>(
    `insert into campaigns (${cols.join(', ')})
     values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    cols.map((c) => row[c]),
  )
  if (!res) throw new Error('seedCampaign failed')
  return res.id
}

export async function getCampaign(id: number): Promise<Campaign> {
  const [row] = await query<Campaign>('select * from campaigns where id = $1', [id])
  if (!row) throw new Error(`campaign ${id} not found`)
  return row
}

/** A PENDING_REVIEW campaign whose card (message 100) shows revision 0. */
export const seedCardCampaign = (over: Record<string, unknown> = {}) =>
  seedCampaign({
    review_chat_id: 1,
    review_message_id: 100,
    review_revision: 0,
    revision: 0,
    ...over,
  })
