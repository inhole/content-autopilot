import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  estimateApplyDeadline,
  fetchGiftProductPrice,
  fetchGiftTrialList,
  giftTrialUrl,
} from '../src/campaigns/gift.ts'
import { campaignPrice, campaignPriceInfo } from '../src/campaigns/types.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/gift/${name}`, import.meta.url), 'utf8'))
const page1 = fixture('page-33325.json')
const page2 = fixture('collections-page2.json')
type Trial = { campaigns: unknown[]; paging: { totalCount: number } }
type PageBody = { components: { contents: { type: string; property: Trial }[] } }
function trialOf(body: PageBody): Trial {
  const c = body.components.contents.find((x) => x.type === 'TRIAL_CAMPAIGN')
  if (!c) throw new Error('fixture has no TRIAL_CAMPAIGN')
  return c.property
}

const item = (id: string) => ({ campaignId: id, campaignTitle: `t-${id}`, brand: null })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const asFetch = (fn: unknown) => fn as typeof fetch

/** Page 1 from the fixture (50 items), page 2 from the fixture, others synthetic. */
function fakeFetch(opts: { lastPage?: number; failPage?: number } = {}) {
  const lastPage = opts.lastPage ?? 4
  const calls: string[] = []
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/v2/pages/')) return json(page1)
    const page = Number(new URL(url).searchParams.get('page'))
    if (page === opts.failPage) return json({}, 500)
    if (page > lastPage) return json({ items: [], paging: { isLast: true } })
    const items =
      page === 2 ? page2.items : Array.from({ length: 5 }, (_, i) => item(`p${page}-${i}`))
    return json({ items, paging: { isLast: page === lastPage } })
  })
  return { impl: asFetch(impl), calls }
}

const fast = { delayMs: 0, retryDelayMs: 0 }

describe('giftTrialUrl', () => {
  it('builds the in-app detail route', () => {
    expect(giftTrialUrl('abc')).toBe('https://gift.kakao.com/giftbox/trial-campaign/abc')
  })
})

describe('fetchGiftTrialList', () => {
  it('reads the first page, then pages 2..N until isLast', async () => {
    const { impl, calls } = fakeFetch({ lastPage: 4 })
    const out = await fetchGiftTrialList({ fetch: impl, ...fast })

    expect(out.items).toHaveLength(50 + 24 + 5 + 5)
    expect(out.totalCount).toBe(475)
    expect(out.invalid).toBe(0)
    expect(calls).toHaveLength(4) // first page + pages 2, 3, 4
    expect(calls[0]).toContain('/v2/pages/33325?page=1&size=20')
    expect(Object.fromEntries(new URL(calls[1] as string).searchParams)).toMatchObject({
      searchId: '2224',
      firstPageSize: '50',
      nextSize: '24',
      page: '2',
      size: '24',
      totalCount: '475',
      totalPage: '20',
    })
  })

  it('stops on an empty page even without isLast', async () => {
    const calls: string[] = []
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/v2/pages/')) return json(page1)
      const page = Number(new URL(url).searchParams.get('page'))
      return json({ items: page === 2 ? page2.items : [] })
    })
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(74)
    expect(calls).toHaveLength(3) // first page, page 2, empty page 3
  })

  it('stops once totalCount items were read', async () => {
    const copy = structuredClone(page1)
    trialOf(copy).paging.totalCount = 74
    const calls: string[] = []
    const impl = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input))
      return String(input).includes('/v2/pages/') ? json(copy) : json({ items: page2.items })
    })
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(74)
    expect(calls).toHaveLength(2)
  })

  it('dedupes by campaignId and counts invalid items', async () => {
    const first = trialOf(page1).campaigns[0]
    const impl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/v2/pages/')
        ? json(page1)
        : json({
            items: [first, { campaignId: '', campaignTitle: 'x' }, item('new')],
            paging: { isLast: true },
          }),
    )
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(51)
    expect(out.invalid).toBe(1)
  })

  it('respects the hard page cap', async () => {
    const copy = structuredClone(page1)
    trialOf(copy).paging.totalCount = 100000
    const calls: string[] = []
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/v2/pages/')) return json(copy)
      return json({ items: [item(`x${new URL(url).searchParams.get('page')}`)] })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(calls).toHaveLength(40) // page 1 + pages 2..40
    expect(out.items).toHaveLength(50 + 39)
    warn.mockRestore()
  })

  it('keeps what it has when a later page keeps failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { impl, calls } = fakeFetch({ failPage: 3 })
    const out = await fetchGiftTrialList({ fetch: impl, ...fast })
    expect(out.items).toHaveLength(74)
    expect(calls.filter((u) => u.includes('page=3&'))).toHaveLength(2) // one retry
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('retries a 429 once and recovers', async () => {
    let n = 0
    const impl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v2/pages/')) return ++n === 1 ? json({}, 429) : json(page1)
      return json({ items: [], paging: { isLast: true } })
    })
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(50)
  })

  it('throws when the first page fails', async () => {
    const impl = vi.fn(async () => json({}, 503))
    await expect(fetchGiftTrialList({ fetch: asFetch(impl), ...fast })).rejects.toThrow(/503/)
  })

  it('does not retry a 404', async () => {
    const impl = vi.fn(async () => json({}, 404))
    await expect(fetchGiftTrialList({ fetch: asFetch(impl), ...fast })).rejects.toThrow(/404/)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('fails loudly on a changed envelope', async () => {
    const noComponent = vi.fn(async () => json({ components: { contents: [{ type: 'BANNER' }] } }))
    await expect(fetchGiftTrialList({ fetch: asFetch(noComponent), ...fast })).rejects.toThrow(
      /TRIAL_CAMPAIGN/,
    )

    const malformed = vi.fn(async () =>
      json({
        components: { contents: [{ type: 'TRIAL_CAMPAIGN', property: { campaigns: 'x' } }] },
      }),
    )
    await expect(fetchGiftTrialList({ fetch: asFetch(malformed), ...fast })).rejects.toThrow(
      /unexpected TRIAL_CAMPAIGN shape/,
    )

    const garbage = vi.fn(async () => json({ nope: true }))
    await expect(fetchGiftTrialList({ fetch: asFetch(garbage), ...fast })).rejects.toThrow(
      /unexpected page envelope/,
    )
  })

  it('treats a malformed collections envelope as a later-page failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const impl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/v2/pages/') ? json(page1) : json({ items: 'nope' }),
    )
    const out = await fetchGiftTrialList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(50)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('estimateApplyDeadline', () => {
  const tz = 'Asia/Seoul'
  it('is the end of the KST day today + remainingDays', () => {
    // 2026-10-18 03:00Z = 12:00 KST
    const d = estimateApplyDeadline(6, new Date('2026-10-18T03:00:00Z'), tz)
    expect(d?.toISOString()).toBe('2026-10-24T14:59:59.999Z') // 23:59:59.999 KST on the 24th
  })

  it('uses the KST calendar day across midnight', () => {
    // 2026-10-17 16:30Z = 2026-10-18 01:30 KST
    expect(estimateApplyDeadline(0, new Date('2026-10-17T16:30:00Z'), tz)?.toISOString()).toBe(
      '2026-10-18T14:59:59.999Z',
    )
    // 2026-10-17 14:30Z = 23:30 KST on the 17th
    expect(estimateApplyDeadline(0, new Date('2026-10-17T14:30:00Z'), tz)?.toISOString()).toBe(
      '2026-10-17T14:59:59.999Z',
    )
  })

  it('crosses month ends and returns null for unknown days', () => {
    expect(estimateApplyDeadline(3, new Date('2026-10-30T03:00:00Z'), tz)?.toISOString()).toBe(
      '2026-11-02T14:59:59.999Z',
    )
    expect(estimateApplyDeadline(null, new Date(), tz)).toBeNull()
    expect(estimateApplyDeadline(undefined, new Date(), tz)).toBeNull()
  })
})

describe('fetchGiftProductPrice', () => {
  const body = { price: { basicPrice: 49000, sellingPrice: 39200, discountRate: 20 }, name: 'x' }
  it('reads basic and selling price from the public product API', async () => {
    const impl = vi.fn(async (_url: string) => json(body))
    const price = await fetchGiftProductPrice(14166987, { fetch: asFetch(impl), retryDelayMs: 0 })
    expect(price).toEqual({ basic: 49000, selling: 39200 })
    expect(String(impl.mock.calls[0]?.[0])).toBe(
      'https://gift.kakao.com/a/product-detail/v3/products/14166987',
    )
  })
  it('keeps a missing side as null', async () => {
    const impl = vi.fn(async () => json({ price: { basicPrice: 14900 } }))
    expect(await fetchGiftProductPrice(1, { fetch: asFetch(impl), retryDelayMs: 0 })).toEqual({
      basic: 14900,
      selling: null,
    })
  })
  it('fails on 404, on a body without prices and on a changed shape', async () => {
    const f = (r: () => Response) => asFetch(vi.fn(async () => r()))
    await expect(
      fetchGiftProductPrice(1, { fetch: f(() => json({}, 404)), retryDelayMs: 0 }),
    ).rejects.toThrow()
    await expect(
      fetchGiftProductPrice(1, { fetch: f(() => json({ price: {} })), retryDelayMs: 0 }),
    ).rejects.toThrow('no price')
    await expect(
      fetchGiftProductPrice(1, { fetch: f(() => json({ other: 1 })), retryDelayMs: 0 }),
    ).rejects.toThrow()
  })
  it('retries a 500 once', async () => {
    const impl = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json(body))
    expect(await fetchGiftProductPrice(1, { fetch: asFetch(impl), retryDelayMs: 0 })).toEqual({
      basic: 49000,
      selling: 39200,
    })
  })
})

describe('campaignPrice', () => {
  it('reads gift detail.price and the Musinsa representative product', () => {
    const gift = (price: unknown) => ({ source: 'kakao-gift', detail: { price } })
    expect(campaignPrice(gift({ basic: 49000, selling: 1 }))).toBe(49000)
    expect(campaignPriceInfo(gift({ basic: 49000, selling: 39200 }))).toEqual({
      price: 49000,
      salePrice: 39200,
    })
    expect(campaignPrice(gift({ basic: null, selling: 9900 }))).toBe(9900)
    expect(campaignPrice({ source: 'kakao-gift', detail: null })).toBeNull()
    expect(campaignPrice(gift('x'))).toBeNull()
    expect(
      campaignPrice({
        source: 'musinsa',
        detail: {
          products: [{ isRepresentative: true, prices: { normalPrice: { value: 59000 } } }],
        },
      }),
    ).toBe(59000)
  })
})
