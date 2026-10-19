import { describe, expect, it } from 'vitest'
import { collectGiftCampaigns } from '../../src/campaigns/collect.ts'
import type { GiftTrialItem } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

const gift = (id: string, over: Partial<GiftTrialItem> = {}): GiftTrialItem => ({
  campaignId: id,
  campaignTitle: `체험단 ${id}`,
  brand: { id: '1', name: '브랜드' },
  imageUrl: 'https://example.com/a.jpg',
  productId: 123,
  remainingDays: 3,
  recruitmentCount: 10,
  applicationCount: 50,
  ...over,
})

const fetchList =
  (items: GiftTrialItem[], invalid = 0) =>
  async () => ({
    items,
    totalCount: items.length,
    invalid,
  })

const now = new Date('2026-10-18T03:00:00Z')
const stubPrice = async () => ({ basic: 50_000, selling: 40_000 })

describe('collectGiftCampaigns', () => {
  it('inserts new campaigns as COLLECTED and returns their ids', async () => {
    const out = await collectGiftCampaigns(now, {
      fetchPrice: stubPrice,
      fetchList: fetchList([gift('a'), gift('b')], 2),
    })

    expect(out).toMatchObject({ fetched: 2, updated: 0, invalid: 2, totalCount: 2 })
    expect(out.created).toHaveLength(2)
    const row = await one("select * from campaigns where external_id = 'a'")
    expect(row).toMatchObject({
      source: 'kakao-gift',
      status: 'COLLECTED',
      url: 'https://gift.kakao.com/giftbox/trial-campaign/a',
      title: '체험단 a',
      brand: '브랜드',
      product_id: 123,
      recruit_count: 10,
      application_count: 50,
      remaining_days: 3,
    })
    expect((row.apply_deadline as Date).toISOString()).toBe('2026-10-21T14:59:59.999Z')
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect((row.detail as GiftTrialItem).campaignId).toBe('a')
    expect(String(row.url_hash)).toHaveLength(64)
  })

  it('refreshes list fields without touching status, score or updated_at', async () => {
    const first = await collectGiftCampaigns(now, {
      fetchPrice: stubPrice,
      fetchList: fetchList([gift('a')]),
    })
    const id = first.created[0] as number
    await query(
      `update campaigns set status = 'APPLIED', score = 8, reason = 'good', memo = 'mine',
         updated_at = '2026-10-18T01:00:00Z' where id = $1`,
      [id],
    )

    const later = new Date('2026-10-19T03:00:00Z')
    const out = await collectGiftCampaigns(later, {
      fetchPrice: stubPrice,
      fetchList: fetchList([gift('a', { applicationCount: 99, remainingDays: 2 }), gift('c')]),
    })

    expect(out.updated).toBe(1)
    expect(out.created).toHaveLength(1)
    expect(out.created[0]).not.toBe(id)
    const row = await one('select * from campaigns where id = $1', [id])
    expect(row).toMatchObject({
      status: 'APPLIED',
      memo: 'mine',
      application_count: 99,
      remaining_days: 2,
    })
    expect(Number(row.score)).toBe(8)
    expect((row.last_seen_at as Date).toISOString()).toBe(later.toISOString())
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect((row.updated_at as Date).toISOString()).toBe('2026-10-18T01:00:00.000Z')
  })

  it('handles an empty list and null optional fields', async () => {
    expect(
      await collectGiftCampaigns(now, { fetchPrice: stubPrice, fetchList: fetchList([]) }),
    ).toMatchObject({
      fetched: 0,
      created: [],
    })
    const out = await collectGiftCampaigns(now, {
      fetchPrice: stubPrice,
      fetchList: fetchList([
        {
          campaignId: 'n',
          campaignTitle: 'no extras',
        },
      ]),
    })
    expect(out.created).toHaveLength(1)
    const row = await one("select * from campaigns where external_id = 'n'")
    expect(row).toMatchObject({ brand: null, apply_deadline: null, recruit_count: null })
  })
})

async function one(sql: string, params: unknown[] = []) {
  const [row] = await query<Record<string, unknown>>(sql, params)
  if (!row) throw new Error('no row')
  return row
}

describe('gift prices', () => {
  const priceOf = async (ext: string) =>
    (await one(`select detail from campaigns where external_id = '${ext}'`)).detail as {
      price?: { basic: number | null; selling: number | null }
      priceTriedAt?: string
    }

  it('stores the price of new rows in detail.price and keeps it on the next collection', async () => {
    const calls: number[] = []
    const fetchPrice = async (id: number) => {
      calls.push(id)
      return { basic: 49_000, selling: 39_200 }
    }
    await collectGiftCampaigns(now, {
      fetchList: fetchList([gift('a', { productId: 11 })]),
      fetchPrice,
      priceDelayMs: 0,
    })
    expect((await priceOf('a')).price).toEqual({ basic: 49_000, selling: 39_200 })
    expect(calls).toEqual([11])

    // The list item has no price, so a refresh must neither wipe it nor fetch it again.
    await collectGiftCampaigns(new Date(now.getTime() + 3_600_000), {
      fetchList: fetchList([gift('a', { productId: 11, applicationCount: 99 })]),
      fetchPrice,
      priceDelayMs: 0,
    })
    expect((await priceOf('a')).price).toEqual({ basic: 49_000, selling: 39_200 })
    expect(calls).toEqual([11])
  })

  it('tolerates failures, does not retry before the wait, then fills rows still without a price', async () => {
    let fail = true
    const calls: number[] = []
    const fetchPrice = async (id: number) => {
      calls.push(id)
      if (fail) throw new Error('boom')
      return { basic: 30_000, selling: null }
    }
    const list = fetchList([gift('a', { productId: 11 }), gift('b', { productId: 12 })])
    const out = await collectGiftCampaigns(now, { fetchList: list, fetchPrice, priceDelayMs: 0 })
    expect(out.created).toHaveLength(2)
    expect((await priceOf('a')).price).toBeUndefined()
    expect((await priceOf('a')).priceTriedAt).toBe(now.toISOString())
    expect(calls).toHaveLength(2)

    fail = false
    const soon = new Date(now.getTime() + 3_600_000)
    await collectGiftCampaigns(soon, { fetchList: list, fetchPrice, priceDelayMs: 0 })
    expect(calls).toHaveLength(2)

    const later = new Date(now.getTime() + 7 * 3_600_000)
    await collectGiftCampaigns(later, { fetchList: list, fetchPrice, priceDelayMs: 0 })
    expect(calls).toHaveLength(4)
    expect((await priceOf('a')).price).toEqual({ basic: 30_000, selling: null })
    expect((await priceOf('a')).priceTriedAt).toBeUndefined()
  })

  it('fetches at most the per-run cap and leaves the rest for the next run', async () => {
    const fetchPrice = async () => ({ basic: 50_000, selling: 40_000 })
    const list = fetchList([
      gift('a', { productId: 1 }),
      gift('b', { productId: 2 }),
      gift('c', { productId: 3 }),
    ])
    await collectGiftCampaigns(now, { fetchList: list, fetchPrice, priceDelayMs: 0, priceCap: 2 })
    const n = await one(
      "select count(*) filter (where detail ? 'price') as n from campaigns where source = 'kakao-gift'",
    )
    expect(n.n).toBe(2)
    await collectGiftCampaigns(now, { fetchList: list, fetchPrice, priceDelayMs: 0, priceCap: 2 })
    const m = await one(
      "select count(*) filter (where detail ? 'price') as n from campaigns where source = 'kakao-gift'",
    )
    expect(m.n).toBe(3)
  })
})
