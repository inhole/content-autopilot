import type { CampaignDetail } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

export const sampleDetail = (over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  title: '무선 이어폰',
  type: 'delivery',
  category: 'IT',
  offer: '무선 이어폰 1개',
  rewardWon: 59000,
  recruitCount: 5,
  applyDeadline: null,
  announceAt: null,
  reviewDeadline: null,
  channel: '네이버 블로그',
  keywords: [],
  guide: '사진 5장',
  applyQuestions: [],
  ...over,
})

let seq = 0

export async function seedCampaign(
  opts: {
    status?: string
    title?: string
    type?: string
    rewardWon?: number | null
    applyDeadline?: Date | null
    applyMessage?: string | null
    revision?: number
    rejectReason?: string | null
    updatedAt?: Date
    detail?: CampaignDetail
  } = {},
): Promise<number> {
  seq += 1
  const detail = opts.detail ?? sampleDetail()
  const [row] = await query<{ id: number }>(
    `insert into campaigns (external_id, url, url_hash, status, title, type, category, reward_won,
       apply_deadline, detail, apply_message, revision, reject_reason, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'IT', $7, $8, $9, $10, $11, $12, coalesce($13, now()))
     returning id`,
    [
      `ext-${seq}`,
      `https://www.revu.net/campaign/${seq}`,
      `hash-${seq}`,
      opts.status ?? 'DETAILED',
      opts.title ?? `캠페인 ${seq}`,
      opts.type ?? 'delivery',
      opts.rewardWon === undefined ? 50000 : opts.rewardWon,
      opts.applyDeadline ?? null,
      JSON.stringify(detail),
      opts.applyMessage ?? null,
      opts.revision ?? 0,
      opts.rejectReason ?? null,
      opts.updatedAt ?? null,
    ],
  )
  if (!row) throw new Error('seedCampaign failed')
  return row.id
}

export async function getCampaign(id: number) {
  const [row] = await query<{
    status: string
    score: number | null
    reason: string | null
    skip_reason: string | null
    apply_message: string | null
    revision: number
  }>('select * from campaigns where id = $1', [id])
  if (!row) throw new Error(`campaign ${id} not found`)
  return row
}
