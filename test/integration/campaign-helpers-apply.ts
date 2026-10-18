import type { Campaign } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

let seq = 0

export async function seedApplyCampaign(
  opts: {
    status?: Campaign['status']
    externalId?: string
    applyMessage?: string | null
    attempts?: number
    announceAt?: Date | null
    reviewDeadline?: Date | null
    selectedAt?: Date | null
    title?: string
  } = {},
): Promise<number> {
  seq++
  const externalId = opts.externalId ?? String(1000 + seq)
  const [row] = await query<{ id: number }>(
    `insert into campaigns (external_id, url, url_hash, status, title, apply_message, attempts,
       announce_at, review_deadline, selected_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      externalId,
      `https://www.revu.net/campaign/${externalId}`,
      `hash-${externalId}-${seq}`,
      opts.status ?? 'APPROVED',
      opts.title ?? '테스트 체험단',
      opts.applyMessage === undefined ? '안녕하세요, 신청합니다.' : opts.applyMessage,
      opts.attempts ?? 0,
      opts.announceAt ?? null,
      opts.reviewDeadline ?? null,
      opts.selectedAt ?? null,
    ],
  )
  if (!row) throw new Error('seedApplyCampaign failed')
  return row.id
}

export async function getApplyCampaign(id: number) {
  const [row] = await query<{
    status: Campaign['status']
    attempts: number
    claim_seq: number
    last_error: string | null
    applied_at: Date | null
    selected_at: Date | null
    screenshot_path: string | null
    external_id: string
  }>(
    `select status, attempts, claim_seq, last_error, applied_at, selected_at, screenshot_path,
       external_id from campaigns where id = $1`,
    [id],
  )
  if (!row) throw new Error(`campaign ${id} not found`)
  return row
}

/** A canned LIST_MY_CAMPAIGN_IDS_SCRIPT result. */
export const list = (ids: string[], loggedIn = true) => ({ ids, loggedIn })
