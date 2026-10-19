import { z } from 'zod'
import { zonedToUtc } from '../lib/time.ts'
import { makeGetJson, sleep } from './http.ts'

// The public 체험단 (preuser) list shown on https://www.musinsa.com/preuser/main. No login needed.
// (influencer.musinsa.com/api2/mcmp is a different, login-only creator-campaign system.)
const API = 'https://www.musinsa.com/preuser/api/v1/event'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const RETRY_DELAY_MS = 2_000
const PAGE_DELAY_MS = 300
// Verified live on 2026-10-19: 1-based pages, 100 is the largest accepted size, and the page past
// the last one answers an empty `content` with hasNext=false.
const PAGE_SIZE = 100
// Hard stop against a pagination loop that never reports its end (352 items = 4 pages today).
const MAX_PAGES = 20
const MAX_OPTION_NAMES = 30

/** The campaign page the owner opens on a PC to apply. */
export const musinsaEventUrl = (eventId: number | string) =>
  `https://www.musinsa.com/preuser/events/${eventId}`

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const optionalDate = isoDate.nullish().catch(null)
const count = z.number().int().nullish()

const priceSchema = z.object({ value: z.number().nullish() }).passthrough()

export const MusinsaProductSchema = z
  .object({
    uniqueId: z.union([z.string().min(1), z.number()]),
    name: z.string().nullish(),
    link: z.string().nullish(),
    isRepresentative: z.boolean().nullish(),
    prices: z
      .object({ normalPrice: priceSchema.nullish(), salePrice: priceSchema.nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough()

/** One item of `/event/events`, the fields we rely on; unknown extra fields are kept. */
export const MusinsaItemSchema = z
  .object({
    id: z.number().int(),
    type: z.string().nullish(),
    state: z.string(),
    name: z.string().min(1),
    mainImage: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: isoDate,
    applicantsCount: count,
    recruitmentCount: count,
    brand: z
      .object({ id: z.union([z.string(), z.number()]).nullish(), name: z.string() })
      .passthrough()
      .nullish(),
    products: z.array(MusinsaProductSchema).default([]),
  })
  .passthrough()
export type MusinsaItem = z.infer<typeof MusinsaItemSchema>

export const MusinsaListSchema = z
  .object({
    data: z.object({ content: z.array(z.unknown()), hasNext: z.boolean() }).passthrough(),
  })
  .passthrough()

const optionItemSchema = z
  .object({
    optionValues: z
      .array(
        z.object({ name: z.string().nullish(), optionName: z.string().nullish() }).passthrough(),
      )
      .default([]),
    outOfStock: z.boolean().nullish(),
    activated: z.boolean().nullish(),
  })
  .passthrough()

/** `/event/events/:id`, the fields we keep. */
export const MusinsaDetailResponseSchema = z
  .object({
    data: z
      .object({
        eventId: z.number().int(),
        eventCategory: z.string().nullish(),
        winnerDrawDate: optionalDate,
        deliveryDate: optionalDate,
        reviewStartDate: optionalDate,
        reviewEndDate: optionalDate,
        registrationPolicy: z
          .object({ minimumMemberLevel: z.number().int().nullish() })
          .passthrough()
          .nullish(),
        products: z
          .array(z.object({ optionItems: z.array(optionItemSchema).default([]) }).passthrough())
          .default([]),
      })
      .passthrough(),
  })
  .passthrough()

/** What the detail endpoint adds to `campaigns.detail` (keys with no value are left out). */
export type MusinsaDetailFields = {
  eventCategory?: string
  winnerDrawDate?: string
  deliveryDate?: string
  reviewStartDate?: string
  reviewEndDate?: string
  minimumMemberLevel?: number
  optionNames?: string[]
}

/** The detail endpoint's response reduced to the fields kept in `campaigns.detail`. */
export function parseMusinsaDetail(raw: unknown): MusinsaDetailFields {
  const d = MusinsaDetailResponseSchema.parse(raw).data
  const names = new Set<string>()
  for (const product of d.products) {
    for (const item of product.optionItems) {
      for (const v of item.optionValues) {
        if (!v.name || v.name === 'NONE') continue
        names.add(v.optionName && v.optionName !== 'NONE' ? `${v.optionName}: ${v.name}` : v.name)
      }
    }
  }
  const out: MusinsaDetailFields = {}
  if (d.eventCategory) out.eventCategory = d.eventCategory
  if (d.winnerDrawDate) out.winnerDrawDate = d.winnerDrawDate
  if (d.deliveryDate) out.deliveryDate = d.deliveryDate
  if (d.reviewStartDate) out.reviewStartDate = d.reviewStartDate
  if (d.reviewEndDate) out.reviewEndDate = d.reviewEndDate
  const level = d.registrationPolicy?.minimumMemberLevel
  if (typeof level === 'number') out.minimumMemberLevel = level
  if (names.size) out.optionNames = [...names].slice(0, MAX_OPTION_NAMES)
  return out
}

type FetchOpts = { fetch?: typeof fetch; delayMs?: number; retryDelayMs?: number }

const getJsonOf = (opts: FetchOpts) =>
  makeGetJson({
    fetch: opts.fetch ?? fetch,
    retryDelayMs: opts.retryDelayMs ?? RETRY_DELAY_MS,
    userAgent: USER_AGENT,
  })

export type MusinsaList = { items: MusinsaItem[]; invalid: number; totalCount?: number | null }

/**
 * Reads the public Musinsa 체험단 list (`/event/events?page=1..&size=100`) and keeps the OPEN items.
 * A failure on the first page throws; a failure on a later page logs a warning and returns what
 * was read so far. Items that do not match the schema are counted, not thrown, but a first page
 * with only invalid items throws (the API shape changed).
 */
export async function fetchMusinsaList(opts: FetchOpts = {}): Promise<MusinsaList> {
  const getJson = getJsonOf(opts)
  const delayMs = opts.delayMs ?? PAGE_DELAY_MS
  const byId = new Map<number, MusinsaItem>()
  let invalid = 0
  let done = false

  for (let page = 1; !done && page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(delayMs)
    try {
      const body = MusinsaListSchema.parse(
        await getJson(`${API}/events?page=${page}&size=${PAGE_SIZE}`),
      )
      let pageInvalid = 0
      for (const raw of body.data.content) {
        const item = MusinsaItemSchema.safeParse(raw)
        if (!item.success) pageInvalid++
        else if (item.data.state === 'OPEN' && !byId.has(item.data.id)) {
          byId.set(item.data.id, item.data)
        }
      }
      invalid += pageInvalid
      if (page === 1 && pageInvalid > 0 && pageInvalid === body.data.content.length) {
        throw new Error(`musinsa list: all ${pageInvalid} items of the first page are invalid`)
      }
      done = !body.data.hasNext || body.data.content.length === 0
    } catch (err) {
      if (page === 1) throw err
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`musinsa list: page ${page} failed, keeping ${byId.size} items: ${reason}`)
      done = true
      break
    }
  }
  if (!done) console.warn(`musinsa list: stopped at the ${MAX_PAGES}-page cap`)

  return { items: [...byId.values()], invalid, totalCount: await fetchTotalCount(getJson) }
}

/** `/event/count`; purely informational, so any failure is null. */
async function fetchTotalCount(getJson: ReturnType<typeof getJsonOf>): Promise<number | null> {
  try {
    const body = z.object({ data: z.number() }).parse(await getJson(`${API}/count`))
    return body.data
  } catch {
    return null
  }
}

/** Reads one event's detail and reduces it to the fields kept in `campaigns.detail`. */
export async function fetchMusinsaDetail(
  eventId: number | string,
  opts: FetchOpts = {},
): Promise<MusinsaDetailFields> {
  return parseMusinsaDetail(await getJsonOf(opts)(`${API}/events/${eventId}`))
}

/** The representative product of an event (else the first one). */
export function representativeProduct(item: Pick<MusinsaItem, 'products'>) {
  return item.products.find((p) => p.isRepresentative) ?? item.products[0]
}

/** The representative product's id as a number (the `campaigns.product_id` column), else null. */
export function musinsaProductId(item: Pick<MusinsaItem, 'products'>): number | null {
  const n = Number(representativeProduct(item)?.uniqueId)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Musinsa is a Korean service: its YYYY-MM-DD dates are KST days, whatever TZ_NAME says. */
export const MUSINSA_TZ = 'Asia/Seoul'

/**
 * End of the calendar day `date` (YYYY-MM-DD) in `tz` (KST by default), 23:59:59.999. Musinsa
 * gives dates only, so the real cut-off hour inside that day is not known; this is the latest it
 * can be. The scheduling/display timezone (TZ_NAME) must not shift the source's deadlines.
 */
export function endOfLocalDay(date: string, tz: string = MUSINSA_TZ): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`unexpected musinsa date: ${date}`)
  return new Date(zonedToUtc(date, '23:59', tz).getTime() + 59_999)
}
