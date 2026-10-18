import type { Campaign } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

let seq = 0

/** Inserts a campaign row; `over` maps column names to values. */
export async function seedCampaign(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1
  const row: Record<string, unknown> = {
    external_id: `gift-${seq}-${Date.now()}`,
    url: `https://gift.kakao.com/campaign/${seq}`,
    url_hash: `hash-${seq}-${Date.now()}`,
    status: 'SELECTED',
    title: `campaign ${seq}`,
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

/** A DRAFT_REVIEW campaign whose control message (id 200) shows revision 1. */
export const seedDraftCampaign = (over: Record<string, unknown> = {}) =>
  seedCampaign({
    status: 'DRAFT_REVIEW',
    memo: '일주일 써봄',
    draft_text: '초안입니다',
    review_chat_id: 1,
    review_message_id: 200,
    review_revision: 1,
    revision: 1,
    ...over,
  })
