import { z } from 'zod'
import { config } from '../config.ts'
import { localDate, zonedToUtc } from '../lib/time.ts'
import { makeGetJson, sleep } from './http.ts'
import { type GiftTrialItem, giftTrialItemSchema } from './types.ts'

const BASE = 'https://gift.kakao.com/a/content-builder'
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KakaoTalk'
const RETRY_DELAY_MS = 2_000
const PAGE_DELAY_MS = 400
// Hard stop against a pagination loop that never reports its end (475 items = 19 pages today).
const MAX_PAGES = 40

/** Gift campaign ids are 24 lowercase hex chars (see test/fixtures/gift). */
export const GIFT_CAMPAIGN_ID_RE = /^[0-9a-f]{24}$/

/** The in-app detail route of a campaign; the owner opens it from the Telegram card. */
export function giftTrialUrl(campaignId: string): string {
  return `https://gift.kakao.com/giftbox/trial-campaign/${campaignId}`
}

// Envelopes are checked strictly for the fields we rely on, so a format change fails loudly.
const searchConditionSchema = z.object({
  searchId: z.number(),
  campaignsRandomSeed: z.number(),
  firstPageSize: z.number(),
  nextSize: z.number(),
})
const trialComponentSchema = z.object({
  type: z.literal('TRIAL_CAMPAIGN'),
  property: z.object({
    campaigns: z.array(z.unknown()),
    searchCondition: searchConditionSchema,
    paging: z.object({
      page: z.number(),
      size: z.number(),
      totalCount: z.number(),
      totalPage: z.number(),
      isLast: z.boolean(),
    }),
  }),
})
const pageEnvelopeSchema = z.object({
  components: z.object({ contents: z.array(z.object({ type: z.string() }).passthrough()) }),
})
const collectionsSchema = z.object({
  items: z.array(z.unknown()),
  paging: z.object({ isLast: z.boolean().optional() }).passthrough().optional(),
})

/**
 * Reads the public Kakao gift trial-campaign list. The first page (`/v2/pages/<pageId>`) carries
 * 50 campaigns plus the search condition and paging; the remaining ones come from
 * `/v1/pages/trial-campaign/collections?page=2,3,...` (size 24). Verified live on 2026-10-18:
 * 475 items = 50 + 17 pages of 24 + a last page (19) of 17 with `paging.isLast = true`; page 20 and
 * beyond answer an empty `items`. Only `isLast` / empty items end the loop (the per-page `paging`
 * counters other than `isLast` are not consistent on the last page).
 *
 * A failure on the first page throws; a failure on a later page logs a warning and returns what was
 * collected so far.
 */
export async function fetchGiftTrialList(
  opts: { pageId?: number; fetch?: typeof fetch; delayMs?: number; retryDelayMs?: number } = {},
): Promise<{ items: GiftTrialItem[]; totalCount: number | null; invalid: number }> {
  const getJson = makeGetJson({
    fetch: opts.fetch ?? fetch,
    retryDelayMs: opts.retryDelayMs ?? RETRY_DELAY_MS,
    userAgent: USER_AGENT,
  })
  const delayMs = opts.delayMs ?? PAGE_DELAY_MS
  const pageId = opts.pageId ?? config.GIFT_TRIAL_PAGE_ID

  const first = await getJson(
    `${BASE}/v2/pages/${pageId}?page=1&size=20&productViewStrategy=WITH_NEXT_PAGE_PREVIEW`,
  )
  const envelope = pageEnvelopeSchema.safeParse(first)
  if (!envelope.success) {
    throw new Error(`gift list: unexpected page envelope: ${z.prettifyError(envelope.error)}`)
  }
  const component = envelope.data.components.contents.find((c) => c.type === 'TRIAL_CAMPAIGN')
  if (!component) throw new Error('gift list: no TRIAL_CAMPAIGN component in the page response')
  const parsed = trialComponentSchema.safeParse(component)
  if (!parsed.success) {
    throw new Error(`gift list: unexpected TRIAL_CAMPAIGN shape: ${z.prettifyError(parsed.error)}`)
  }
  const { campaigns, searchCondition: sc, paging } = parsed.data.property

  const byId = new Map<string, GiftTrialItem>()
  let invalid = 0
  const add = (raw: unknown[]) => {
    for (const r of raw) {
      const item = giftTrialItemSchema.safeParse(r)
      if (!item.success) invalid++
      else if (!byId.has(item.data.campaignId)) byId.set(item.data.campaignId, item.data)
    }
  }
  add(campaigns)

  let seen = campaigns.length
  let done = paging.isLast || seen >= paging.totalCount
  for (let page = 2; !done && page <= MAX_PAGES; page++) {
    await sleep(delayMs)
    const query = new URLSearchParams({
      searchId: String(sc.searchId),
      campaignsRandomSeed: String(sc.campaignsRandomSeed),
      firstPageSize: String(sc.firstPageSize),
      nextSize: String(sc.nextSize),
      page: String(page),
      size: String(paging.size),
      totalCount: String(paging.totalCount),
      totalPage: String(paging.totalPage),
    })
    try {
      const body = collectionsSchema.parse(
        await getJson(`${BASE}/v1/pages/trial-campaign/collections?${query}`),
      )
      add(body.items)
      seen += body.items.length
      done = body.items.length === 0 || body.paging?.isLast === true || seen >= paging.totalCount
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`gift list: page ${page} failed, keeping ${byId.size} items: ${reason}`)
      break
    }
  }
  if (!done) console.warn(`gift list: stopped at the ${MAX_PAGES}-page cap with ${byId.size} items`)

  return { items: [...byId.values()], totalCount: paging.totalCount, invalid }
}

/**
 * ESTIMATE of the apply deadline: the list only gives "remaining days", so this is the end
 * (23:59:59.999) of the calendar day `today + remainingDays` in `tz`. The real cut-off hour is
 * unknown, and the number itself is a rounded countdown, so treat it as approximate.
 */
export function estimateApplyDeadline(
  remainingDays: number | null | undefined,
  now: Date,
  tz: string,
): Date | null {
  if (remainingDays == null || !Number.isFinite(remainingDays)) return null
  const day = new Date(`${localDate(now, tz)}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + Math.trunc(remainingDays))
  const endOfDay = zonedToUtc(day.toISOString().slice(0, 10), '23:59', tz)
  return new Date(endOfDay.getTime() + 59_999)
}
