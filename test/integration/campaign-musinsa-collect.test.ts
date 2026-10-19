import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { collectGiftCampaigns, collectMusinsaCampaigns } from '../../src/campaigns/collect.ts'
import { runMusinsaCollect } from '../../src/campaigns/jobs.ts'
import { type MusinsaItem, MusinsaItemSchema } from '../../src/campaigns/musinsa.ts'
import { markResult, setReviewDeadline } from '../../src/campaigns/review.ts'
import { query } from '../../src/db/pool.ts'
import { getCampaign, seedCampaign } from './campaign-helpers-review.ts'

const item = (id: number, over: Record<string, unknown> = {}): MusinsaItem =>
  MusinsaItemSchema.parse({
    id,
    type: 'GOODS',
    state: 'OPEN',
    name: `상품 ${id}`,
    mainImage: 'https://image.msscdn.net/a.jpg',
    startDate: '2026-10-18',
    endDate: '2026-10-20',
    applicantsCount: 120,
    recruitmentCount: 10,
    brand: { id: 'b', name: '브랜드' },
    products: [
      {
        uniqueId: String(7000000 + id),
        isRepresentative: true,
        prices: { normalPrice: { value: 25000 }, salePrice: { value: 14990 } },
      },
      { uniqueId: String(8000000 + id) },
    ],
    ...over,
  })

const fetchList =
  (items: MusinsaItem[], invalid = 0) =>
  async () => ({ items, invalid, totalCount: items.length })

const detailFields = {
  eventCategory: 'FASHION_ACCESSORY',
  winnerDrawDate: '2026-10-27',
  deliveryDate: '2026-10-29',
  reviewStartDate: '2026-10-31',
  reviewEndDate: '2026-11-14',
  minimumMemberLevel: 2,
}
const fetchDetail = async () => detailFields
const noDelay = { detailDelayMs: 0 }

// 2026-10-18 12:00 KST
const now = new Date('2026-10-18T03:00:00Z')
const stubPrice = async () => ({ basic: 50_000, selling: 40_000 })

const one = async (sql: string, params: unknown[] = []) => {
  const [row] = await query<Record<string, unknown>>(sql, params)
  if (!row) throw new Error('no row')
  return row
}

describe('collectMusinsaCampaigns', () => {
  it('inserts new campaigns as COLLECTED with the mapped list fields', async () => {
    const out = await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1), item(2)], 1),
      fetchDetail,
      ...noDelay,
    })
    expect(out).toMatchObject({ fetched: 2, updated: 0, invalid: 1, totalCount: 2 })
    expect(out.created).toHaveLength(2)

    const row = await one("select * from campaigns where source = 'musinsa' and external_id = '1'")
    expect(row).toMatchObject({
      status: 'COLLECTED',
      url: 'https://www.musinsa.com/preuser/events/1',
      title: '상품 1',
      brand: '브랜드',
      image_url: 'https://image.msscdn.net/a.jpg',
      recruit_count: 10,
      application_count: 120,
      product_id: 7000001,
      remaining_days: 2,
    })
    // End of the KST day 2026-10-20.
    expect((row.apply_deadline as Date).toISOString()).toBe('2026-10-20T14:59:59.999Z')
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect(String(row.url_hash)).toHaveLength(64)
    expect(row.detail).toMatchObject({ id: 1, ...detailFields })
  })

  it('fetches the detail for new rows only', async () => {
    const calls: string[] = []
    const spy = async (id: string | number) => {
      calls.push(String(id))
      return detailFields
    }
    await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1)]),
      fetchDetail: spy,
      ...noDelay,
    })
    await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1), item(2)]),
      fetchDetail: spy,
      ...noDelay,
    })
    expect(calls).toEqual(['1', '2'])
  })

  it('survives a failing detail fetch and keeps the row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1), item(2)]),
      fetchDetail: async (id) => {
        if (String(id) === '1') throw new Error('HTTP 500')
        return detailFields
      },
      ...noDelay,
    })
    warn.mockRestore()
    expect(out.created).toHaveLength(2)
    const failed = await one("select detail from campaigns where external_id = '1'")
    expect((failed.detail as Record<string, unknown>).eventCategory).toBeUndefined()
    expect((failed.detail as { id: number }).id).toBe(1)
    const ok = await one("select detail from campaigns where external_id = '2'")
    expect((ok.detail as Record<string, unknown>).eventCategory).toBe('FASHION_ACCESSORY')
  })

  it('refreshes list fields without touching status, owner fields, updated_at or detail fields', async () => {
    const first = await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1)]),
      fetchDetail,
      ...noDelay,
    })
    const id = first.created[0] as number
    await query(
      `update campaigns set status = 'APPLIED', score = 8, memo = 'mine',
         updated_at = '2026-10-18T01:00:00Z' where id = $1`,
      [id],
    )
    const later = new Date('2026-10-19T03:00:00Z')
    const out = await collectMusinsaCampaigns(later, {
      fetchList: fetchList([item(1, { endDate: '2026-10-22', applicantsCount: 300 })]),
      fetchDetail: async () => {
        throw new Error('must not be called for an existing row')
      },
      ...noDelay,
    })
    expect(out).toMatchObject({ created: [], updated: 1 })
    const row = await one('select * from campaigns where id = $1', [id])
    expect(row).toMatchObject({
      status: 'APPLIED',
      score: 8,
      memo: 'mine',
      remaining_days: 3,
      application_count: 300,
    })
    expect((row.apply_deadline as Date).toISOString()).toBe('2026-10-22T14:59:59.999Z')
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect((row.last_seen_at as Date).toISOString()).toBe(later.toISOString())
    expect((row.updated_at as Date).toISOString()).toBe('2026-10-18T01:00:00.000Z')
    // The list item overwrote its own fields; the detail-only fields stayed.
    expect(row.detail).toMatchObject({ endDate: '2026-10-22', ...detailFields })
  })

  it('leaves kakao-gift rows alone, even with the same external id', async () => {
    await collectGiftCampaigns(now, {
      fetchPrice: stubPrice,
      fetchList: async () => ({
        items: [{ campaignId: '7', campaignTitle: '선물', remainingDays: 3 }],
        totalCount: 1,
        invalid: 0,
      }),
    })
    await collectMusinsaCampaigns(now, { fetchList: fetchList([item(7)]), fetchDetail, ...noDelay })
    const rows = await query<{ source: string; title: string }>(
      "select source, title from campaigns where external_id = '7' order by source",
    )
    expect(rows).toEqual([
      { source: 'kakao-gift', title: '선물' },
      { source: 'musinsa', title: '상품 7' },
    ])
  })

  it('does nothing for an empty list', async () => {
    expect(await collectMusinsaCampaigns(now, { fetchList: fetchList([]) })).toMatchObject({
      fetched: 0,
      created: [],
    })
  })
})

describe('runMusinsaCollect', () => {
  it('collect failure propagates (the queue retries)', async () => {
    // A failing first page throws before anything is ranked or sent.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch
    try {
      await expect(runMusinsaCollect(async () => {}, now)).rejects.toThrow('403')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('markResult review deadline from the source', () => {
  const musinsaRow = (over: Record<string, unknown> = {}) =>
    seedCampaign({
      source: 'musinsa',
      status: 'APPLIED',
      detail: JSON.stringify({ reviewEndDate: '2026-11-14' }),
      ...over,
    })

  it('fills review_deadline with the end of the KST reviewEndDate when selected', async () => {
    const id = await musinsaRow()
    expect(await markResult(id, true)).toBe(true)
    expect((await getCampaign(id)).review_deadline?.toISOString()).toBe('2026-11-14T14:59:59.999Z')
  })

  it('keeps a deadline that was already set, and /due still overrides it', async () => {
    const set = new Date('2026-11-01T14:59:00Z')
    const id = await musinsaRow({ review_deadline: set })
    await markResult(id, true)
    expect((await getCampaign(id)).review_deadline?.toISOString()).toBe(set.toISOString())

    const other = await musinsaRow()
    await markResult(other, true)
    const due = new Date('2026-11-10T14:59:59.999Z')
    expect(await setReviewDeadline(other, due)).toBe(true)
    expect((await getCampaign(other)).review_deadline?.toISOString()).toBe(due.toISOString())
  })

  it('leaves it empty when not selected, without a date or with a bad one', async () => {
    const unselected = await musinsaRow()
    await markResult(unselected, false)
    expect((await getCampaign(unselected)).review_deadline).toBeNull()

    const none = await musinsaRow({ detail: JSON.stringify({}) })
    await markResult(none, true)
    expect((await getCampaign(none)).review_deadline).toBeNull()

    const bad = await musinsaRow({ detail: JSON.stringify({ reviewEndDate: 'later' }) })
    expect(await markResult(bad, true)).toBe(true)
    expect((await getCampaign(bad)).review_deadline).toBeNull()

    const gift = await seedCampaign({ status: 'APPLIED' })
    await markResult(gift, true)
    expect((await getCampaign(gift)).review_deadline).toBeNull()
  })
})

describe('migration 018', () => {
  it('deletes only musinsa rows and their reminders', async () => {
    const m = await seedCampaign({ source: 'musinsa', status: 'APPLIED' })
    const g = await seedCampaign({ source: 'kakao-gift', status: 'APPLIED' })
    await query(
      "insert into campaign_reminders (campaign_id, kind) values ($1, 'review-d3'), ($2, 'review-d3')",
      [m, g],
    )

    const sql = readFileSync(
      new URL('../../migrations/018_musinsa_preuser.sql', import.meta.url),
      'utf8',
    )
    await query(sql)

    const left = await query<{ id: number; source: string }>('select id, source from campaigns')
    expect(left).toEqual([{ id: g, source: 'kakao-gift' }])
    const reminders = await query<{ campaign_id: number }>(
      'select campaign_id from campaign_reminders',
    )
    expect(reminders).toEqual([{ campaign_id: g }])
  })
})
