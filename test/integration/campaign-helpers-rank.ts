import { query } from '../../src/db/pool.ts'

let seq = 0

/** Statuses a campaign can only reach by being picked, so they get shortlisted_at by default. */
const PICKED = ['SHORTLISTED', 'PENDING_REVIEW', 'REJECTED', 'APPLIED', 'SELECTED']

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
    /** Defaults to updatedAt (or now) for picked statuses, null otherwise. */
    shortlistedAt?: Date | null
    source?: string
    detail?: unknown
    productId?: number | null
  } = {},
): Promise<number> {
  seq += 1
  const status = opts.status ?? 'COLLECTED'
  const shortlistedAt =
    opts.shortlistedAt !== undefined
      ? opts.shortlistedAt
      : PICKED.includes(status)
        ? (opts.updatedAt ?? new Date())
        : null
  const [row] = await query<{ id: number }>(
    `insert into campaigns (external_id, url, url_hash, status, title, brand, recruit_count,
       application_count, remaining_days, apply_deadline, reject_reason, updated_at, source, detail,
       shortlisted_at, product_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, now()), $13, $14, $15, $16)
     returning id`,
    [
      `ext-${seq}`,
      `https://gift.kakao.com/giftbox/trial-campaign/ext-${seq}`,
      `hash-${seq}`,
      status,
      opts.title ?? `캠페인 ${seq}`,
      opts.brand === undefined ? '브랜드' : opts.brand,
      opts.recruitCount === undefined ? 10 : opts.recruitCount,
      opts.applicationCount === undefined ? 100 : opts.applicationCount,
      opts.remainingDays === undefined ? 5 : opts.remainingDays,
      opts.applyDeadline ?? null,
      opts.rejectReason ?? null,
      opts.updatedAt ?? null,
      opts.source ?? 'kakao-gift',
      opts.detail == null ? null : JSON.stringify(opts.detail),
      shortlistedAt,
      opts.productId ?? null,
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
