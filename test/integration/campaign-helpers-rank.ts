import { query } from '../../src/db/pool.ts'

let seq = 0

export async function seedCampaign(
  opts: {
    status?: string
    title?: string
    brand?: string | null
    recruitCount?: number | null
    applicationCount?: number | null
    remainingDays?: number | null
    applyDeadline?: Date | null
    rejectReason?: string | null
    updatedAt?: Date
  } = {},
): Promise<number> {
  seq += 1
  const [row] = await query<{ id: number }>(
    `insert into campaigns (external_id, url, url_hash, status, title, brand, recruit_count,
       application_count, remaining_days, apply_deadline, reject_reason, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, now()))
     returning id`,
    [
      `ext-${seq}`,
      `https://gift.kakao.com/giftbox/trial-campaign/ext-${seq}`,
      `hash-${seq}`,
      opts.status ?? 'COLLECTED',
      opts.title ?? `캠페인 ${seq}`,
      opts.brand === undefined ? '브랜드' : opts.brand,
      opts.recruitCount === undefined ? 10 : opts.recruitCount,
      opts.applicationCount === undefined ? 100 : opts.applicationCount,
      opts.remainingDays === undefined ? 5 : opts.remainingDays,
      opts.applyDeadline ?? null,
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
  }>('select * from campaigns where id = $1', [id])
  if (!row) throw new Error(`campaign ${id} not found`)
  return row
}
