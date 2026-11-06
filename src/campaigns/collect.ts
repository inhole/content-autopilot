import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'
import {
  estimateApplyDeadline,
  fetchGiftProductPrice,
  fetchGiftTrialList,
  giftTrialUrl,
} from './gift.ts'
import { sleep } from './http.ts'
import {
  endOfLocalDay,
  fetchMusinsaDetail,
  fetchMusinsaList,
  type MusinsaDetailFields,
  musinsaEventUrl,
  musinsaProductId,
} from './musinsa.ts'
import { type CampaignSource, daysUntil, type GiftPrice } from './types.ts'

export type GiftCollectResult = {
  fetched: number
  created: number[]
  updated: number
  invalid: number
  totalCount: number | null
}

/**
 * Upserts the public Kakao gift trial list into `campaigns`. New rows start as COLLECTED; existing
 * rows only get their list fields (counts, remaining days, estimated deadline, raw item) and
 * last_seen_at refreshed. Status, score and owner fields are never touched, and neither is
 * updated_at, which the daily quota in rank.ts relies on.
 */
export async function collectGiftCampaigns(
  now = new Date(),
  opts: {
    fetchList?: typeof fetchGiftTrialList
    fetchPrice?: (productId: number) => Promise<GiftPrice>
    priceDelayMs?: number
    priceCap?: number
  } = {},
): Promise<GiftCollectResult> {
  const { items, totalCount, invalid } = await (opts.fetchList ?? fetchGiftTrialList)()
  if (items.length === 0) return { fetched: 0, created: [], updated: 0, invalid, totalCount }

  const rows = items.map((item) => {
    const url = giftTrialUrl(item.campaignId)
    return {
      external_id: item.campaignId,
      url,
      url_hash: urlHash(url),
      title: item.campaignTitle,
      brand: item.brand?.name ?? null,
      product_id: item.productId ?? null,
      image_url: item.imageUrl ?? null,
      recruit_count: item.recruitmentCount ?? null,
      application_count: item.applicationCount ?? null,
      remaining_days: item.remainingDays ?? null,
      apply_deadline: estimateApplyDeadline(item.remainingDays, now, config.TZ_NAME),
      detail: item,
    }
  })

  const result = await upsertCampaigns('kakao-gift', rows, now)

  await fillGiftPrices(now, {
    fetchPrice: opts.fetchPrice ?? fetchGiftProductPrice,
    delayMs: opts.priceDelayMs ?? PRICE_DELAY_MS,
    cap: opts.priceCap ?? PRICE_CAP_PER_RUN,
  })

  const created = result
    .filter((r) => r.inserted)
    .map((r) => r.id)
    .sort((a, b) => a - b)
  return {
    fetched: items.length,
    created,
    updated: result.length - created.length,
    invalid,
    totalCount,
  }
}

const PRICE_DELAY_MS = 300
// One run fetches at most this many prices (the first run sees ~475 rows; the rest follow later).
const PRICE_CAP_PER_RUN = 150
// A product whose price fetch failed is not retried before this much time has passed.
const PRICE_RETRY_AFTER_HOURS = 6

/**
 * Fetches the list price of COLLECTED gift rows that have none yet (new rows first) and stores it
 * in `detail.price` ({ basic, selling }). One request at a time, `delayMs` apart, at most `cap` per
 * run. A failure is logged and remembered in `detail.priceTriedAt` so it neither fails the
 * collection nor eats the cap on every run. updated_at is not touched.
 */
export async function fillGiftPrices(
  now: Date,
  opts: { fetchPrice: (productId: number) => Promise<GiftPrice>; delayMs: number; cap: number },
): Promise<{ filled: number; failed: number }> {
  const rows = await query<{ id: number; product_id: number }>(
    `select id, product_id from campaigns
      where source = 'kakao-gift' and status = 'COLLECTED' and product_id is not null
        and not (coalesce(detail, '{}'::jsonb) ? 'price')
        and (detail->>'priceTriedAt' is null
             or (detail->>'priceTriedAt')::timestamptz < $1::timestamptz - make_interval(hours => $2))
      order by first_seen_at desc, id desc
      limit $3`,
    [now, PRICE_RETRY_AFTER_HOURS, opts.cap],
  )
  let filled = 0
  let failed = 0
  let first = true
  for (const row of rows) {
    if (!first) await sleep(opts.delayMs)
    first = false
    try {
      const price = await opts.fetchPrice(row.product_id)
      await query(
        `update campaigns set detail = (coalesce(detail, '{}'::jsonb) - 'priceTriedAt')
           || jsonb_build_object('price', $2::jsonb) where id = $1`,
        [row.id, JSON.stringify(price)],
      )
      filled++
    } catch (err) {
      failed++
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`gift price: #${row.id} (product ${row.product_id}) skipped: ${reason}`)
      await query(
        `update campaigns set detail = coalesce(detail, '{}'::jsonb)
           || jsonb_build_object('priceTriedAt', $2::text) where id = $1`,
        [row.id, now.toISOString()],
      )
    }
  }
  return { filled, failed }
}

const DETAIL_DELAY_MS = 300
// Same cap as the gift price fill; the rest follow in later runs.
const DETAIL_CAP_PER_RUN = 150

/**
 * Upserts the public Musinsa 체험단 list into `campaigns`, source 'musinsa'. Same rules as the gift
 * collector: new rows are COLLECTED, existing rows only get their list fields and last_seen_at
 * refreshed (fields that only the detail endpoint gave stay). Musinsa gives exact end dates and
 * counts. Then the event detail of COLLECTED rows never tried is fetched (`fillMusinsaDetails`); a
 * failed detail fetch is logged and never fails the collection.
 */
export async function collectMusinsaCampaigns(
  now = new Date(),
  opts: {
    fetchList?: typeof fetchMusinsaList
    fetchDetail?: typeof fetchMusinsaDetail
    detailDelayMs?: number
    detailCap?: number
  } = {},
): Promise<GiftCollectResult> {
  const { items, invalid, totalCount = null } = await (opts.fetchList ?? fetchMusinsaList)()
  if (items.length === 0) return { fetched: 0, created: [], updated: 0, invalid, totalCount }

  const rows = items.map((item) => {
    const url = musinsaEventUrl(item.id)
    const deadline = endOfLocalDay(item.endDate)
    return {
      external_id: String(item.id),
      url,
      url_hash: urlHash(url),
      title: item.name,
      brand: item.brand?.name ?? null,
      product_id: musinsaProductId(item),
      image_url: item.mainImage ?? null,
      recruit_count: item.recruitmentCount ?? null,
      application_count: item.applicantsCount ?? null,
      remaining_days: daysUntil(deadline, now, config.TZ_NAME),
      apply_deadline: deadline,
      detail: item,
    }
  })

  const result = await upsertCampaigns('musinsa', rows, now)
  await fillMusinsaDetails(now, {
    fetchDetail: opts.fetchDetail ?? fetchMusinsaDetail,
    delayMs: opts.detailDelayMs ?? DETAIL_DELAY_MS,
    cap: opts.detailCap ?? DETAIL_CAP_PER_RUN,
  })

  const inserted = result.filter((r) => r.inserted).sort((a, b) => a.id - b.id)
  return {
    fetched: items.length,
    created: inserted.map((r) => r.id),
    updated: result.length - inserted.length,
    invalid,
    totalCount,
  }
}

/**
 * Fetches the event detail of COLLECTED Musinsa rows never tried yet (`detail.detailTriedAt`
 * missing; new rows first), one request at a time, `delayMs` apart, at most `cap` per run, and
 * merges it into `campaigns.detail`. Success and failure both stamp `detailTriedAt`, so a run that
 * crashed mid-way or hit the cap is picked up by the next run, while a failure (logged, never
 * failing the collection) is not retried. updated_at is not touched.
 */
async function fillMusinsaDetails(
  now: Date,
  opts: {
    fetchDetail: (eventId: string) => Promise<MusinsaDetailFields>
    delayMs: number
    cap: number
  },
): Promise<void> {
  const rows = await query<{ id: number; external_id: string }>(
    `select id, external_id from campaigns
      where source = 'musinsa' and status = 'COLLECTED'
        and not (coalesce(detail, '{}'::jsonb) ? 'detailTriedAt')
      order by first_seen_at desc, id
      limit $1`,
    [opts.cap],
  )
  let first = true
  for (const row of rows) {
    if (!first) await sleep(opts.delayMs)
    first = false
    let fields: object = {}
    try {
      fields = await opts.fetchDetail(row.external_id)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`musinsa detail: #${row.id} (${row.external_id}) skipped: ${reason}`)
    }
    await query(
      `update campaigns set detail = coalesce(detail, '{}'::jsonb) || $2::jsonb
         || jsonb_build_object('detailTriedAt', $3::text) where id = $1`,
      [row.id, JSON.stringify(fields), now.toISOString()],
    )
  }
}

type CampaignRow = {
  external_id: string
  url: string
  url_hash: string
  title: string
  brand: string | null
  product_id: number | null
  image_url: string | null
  recruit_count: number | null
  application_count: number | null
  remaining_days: number | null
  apply_deadline: Date | null
  detail: unknown
}

/**
 * Inserts new list rows as COLLECTED; existing rows (same source and external id) only get their
 * list fields and last_seen_at refreshed, and the list item is merged over the stored `detail`
 * (`||`) so fields only the price or detail fetch gave survive.
 */
function upsertCampaigns(source: CampaignSource, rows: CampaignRow[], now: Date) {
  return query<{ id: number; inserted: boolean }>(
    `insert into campaigns (source, external_id, url, url_hash, status, title, brand, product_id,
       image_url, recruit_count, application_count, remaining_days, apply_deadline, detail,
       first_seen_at, last_seen_at)
     select $3, r.external_id, r.url, r.url_hash, 'COLLECTED', r.title, r.brand,
       r.product_id, r.image_url, r.recruit_count, r.application_count, r.remaining_days,
       r.apply_deadline, r.detail, $2, $2
     from jsonb_to_recordset($1::jsonb) as r(external_id text, url text, url_hash text, title text,
       brand text, product_id bigint, image_url text, recruit_count integer,
       application_count integer, remaining_days integer, apply_deadline timestamptz, detail jsonb)
     on conflict (source, external_id) do update set
       title = excluded.title,
       brand = excluded.brand,
       product_id = excluded.product_id,
       image_url = excluded.image_url,
       recruit_count = excluded.recruit_count,
       application_count = excluded.application_count,
       remaining_days = excluded.remaining_days,
       apply_deadline = excluded.apply_deadline,
       detail = coalesce(campaigns.detail, '{}'::jsonb) || excluded.detail,
       last_seen_at = excluded.last_seen_at
     returning id, (xmax = 0) as inserted`,
    [JSON.stringify(rows), now, source],
  )
}
