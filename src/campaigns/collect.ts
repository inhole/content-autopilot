import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { localDate } from '../lib/time.ts'
import { urlHash } from '../lib/url.ts'
import { estimateApplyDeadline, fetchGiftTrialList, giftTrialUrl } from './gift.ts'
import { sleep } from './http.ts'
import {
  endOfLocalDay,
  fetchMusinsaDetail,
  fetchMusinsaList,
  type MusinsaDetailFields,
  musinsaEventUrl,
  musinsaProductId,
} from './musinsa.ts'

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
  opts: { fetchList?: typeof fetchGiftTrialList } = {},
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

  const result = await query<{ id: number; inserted: boolean }>(
    `insert into campaigns (source, external_id, url, url_hash, status, title, brand, product_id,
       image_url, recruit_count, application_count, remaining_days, apply_deadline, detail,
       first_seen_at, last_seen_at)
     select 'kakao-gift', r.external_id, r.url, r.url_hash, 'COLLECTED', r.title, r.brand,
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
       detail = excluded.detail,
       last_seen_at = excluded.last_seen_at
     returning id, (xmax = 0) as inserted`,
    [JSON.stringify(rows), now],
  )

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

/** Whole local calendar days from `now` to `target` in `tz` (negative when past). */
function calendarDaysUntil(target: Date, now: Date, tz: string): number {
  const day = (d: Date) => Date.parse(`${localDate(d, tz)}T00:00:00Z`)
  return Math.round((day(target) - day(now)) / 86_400_000)
}

const DETAIL_DELAY_MS = 300

/**
 * Upserts the public Musinsa 체험단 list into `campaigns`, source 'musinsa'. Same rules as the gift
 * collector: new rows are COLLECTED, existing rows only get their list fields and last_seen_at
 * refreshed (fields that only the detail endpoint gave stay). Musinsa gives exact end dates and
 * counts. For newly created rows the event detail is fetched too; a failed detail fetch is logged
 * and never fails the collection.
 */
export async function collectMusinsaCampaigns(
  now = new Date(),
  opts: {
    fetchList?: typeof fetchMusinsaList
    fetchDetail?: typeof fetchMusinsaDetail
    detailDelayMs?: number
  } = {},
): Promise<GiftCollectResult> {
  const { items, invalid, totalCount = null } = await (opts.fetchList ?? fetchMusinsaList)()
  if (items.length === 0) return { fetched: 0, created: [], updated: 0, invalid, totalCount }

  const rows = items.map((item) => {
    const url = musinsaEventUrl(item.id)
    const deadline = endOfLocalDay(item.endDate, config.TZ_NAME)
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
      remaining_days: calendarDaysUntil(deadline, now, config.TZ_NAME),
      apply_deadline: deadline,
      detail: item,
    }
  })

  const result = await query<{ id: number; external_id: string; inserted: boolean }>(
    `insert into campaigns (source, external_id, url, url_hash, status, title, brand, product_id,
       image_url, recruit_count, application_count, remaining_days, apply_deadline, detail,
       first_seen_at, last_seen_at)
     select 'musinsa', r.external_id, r.url, r.url_hash, 'COLLECTED', r.title, r.brand,
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
     returning id, external_id, (xmax = 0) as inserted`,
    [JSON.stringify(rows), now],
  )

  const inserted = result.filter((r) => r.inserted).sort((a, b) => a.id - b.id)
  await storeDetails(inserted, opts.fetchDetail ?? fetchMusinsaDetail, {
    delayMs: opts.detailDelayMs ?? DETAIL_DELAY_MS,
  })
  return {
    fetched: items.length,
    created: inserted.map((r) => r.id),
    updated: result.length - inserted.length,
    invalid,
    totalCount,
  }
}

/**
 * Fetches the event detail of each new row (one request at a time, `delayMs` apart) and merges it
 * into `campaigns.detail`. Per-row failures are logged and skipped. updated_at is not touched.
 */
async function storeDetails(
  rows: { id: number; external_id: string }[],
  fetchDetail: (eventId: string) => Promise<MusinsaDetailFields>,
  opts: { delayMs: number },
): Promise<void> {
  let first = true
  for (const row of rows) {
    if (!first) await sleep(opts.delayMs)
    first = false
    try {
      const fields = await fetchDetail(row.external_id)
      await query(
        "update campaigns set detail = coalesce(detail, '{}'::jsonb) || $2::jsonb where id = $1",
        [row.id, JSON.stringify(fields)],
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`musinsa detail: #${row.id} (${row.external_id}) skipped: ${reason}`)
    }
  }
}
