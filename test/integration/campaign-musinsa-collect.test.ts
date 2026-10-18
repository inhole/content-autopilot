import { describe, expect, it } from 'vitest'
import { collectGiftCampaigns, collectMusinsaCampaigns } from '../../src/campaigns/collect.ts'
import { type MusinsaItem, MusinsaItemSchema } from '../../src/campaigns/musinsa.ts'
import { query } from '../../src/db/pool.ts'

const item = (id: number, over: Record<string, unknown> = {}): MusinsaItem =>
  MusinsaItemSchema.parse({
    campaignId: id,
    campaignEndDate: '2026-10-20T23:59:59',
    brandName: '브랜드',
    representativeGoods: {
      goodsImageUrl: 'https://example.com/a.jpg',
      goodsName: `상품 ${id}`,
      price: 1000,
    },
    goodsCount: 1,
    contentType: 'IMAGE',
    ...over,
  })

const fetchList =
  (items: MusinsaItem[], invalid = 0) =>
  async () => ({ items, invalid })

// 2026-10-18 12:00 KST
const now = new Date('2026-10-18T03:00:00Z')

const one = async (sql: string, params: unknown[] = []) => {
  const [row] = await query<Record<string, unknown>>(sql, params)
  if (!row) throw new Error('no row')
  return row
}

describe('collectMusinsaCampaigns', () => {
  it('inserts new campaigns as COLLECTED', async () => {
    const out = await collectMusinsaCampaigns(now, {
      fetchList: fetchList([item(1), item(2, { goodsCount: 3 })], 1),
    })
    expect(out).toMatchObject({ fetched: 2, updated: 0, invalid: 1, totalCount: 2 })
    expect(out.created).toHaveLength(2)

    const row = await one("select * from campaigns where source = 'musinsa' and external_id = '1'")
    expect(row).toMatchObject({
      status: 'COLLECTED',
      url: 'https://www.musinsa.com/preuser/events/1',
      title: '상품 1',
      brand: '브랜드',
      image_url: 'https://example.com/a.jpg',
      recruit_count: null,
      application_count: null,
      remaining_days: 2,
    })
    expect((row.apply_deadline as Date).toISOString()).toBe('2026-10-20T14:59:59.000Z')
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect(String(row.url_hash)).toHaveLength(64)
    expect((row.detail as { campaignId: number }).campaignId).toBe(1)
    const prefixed = await one("select title from campaigns where external_id = '2'")
    expect(prefixed.title).toBe('[+2] 상품 2')
  })

  it('refreshes list fields without touching status, owner fields or updated_at', async () => {
    const first = await collectMusinsaCampaigns(now, { fetchList: fetchList([item(1)]) })
    const id = first.created[0] as number
    await query(
      `update campaigns set status = 'APPLIED', score = 8, memo = 'mine',
         updated_at = '2026-10-18T01:00:00Z' where id = $1`,
      [id],
    )
    const later = new Date('2026-10-19T03:00:00Z')
    const out = await collectMusinsaCampaigns(later, {
      fetchList: fetchList([item(1, { campaignEndDate: '2026-10-22T23:59:59' })]),
    })
    expect(out).toMatchObject({ created: [], updated: 1 })
    const row = await one('select * from campaigns where id = $1', [id])
    expect(row).toMatchObject({ status: 'APPLIED', score: 8, memo: 'mine', remaining_days: 3 })
    expect((row.apply_deadline as Date).toISOString()).toBe('2026-10-22T14:59:59.000Z')
    expect((row.first_seen_at as Date).toISOString()).toBe(now.toISOString())
    expect((row.last_seen_at as Date).toISOString()).toBe(later.toISOString())
    expect((row.updated_at as Date).toISOString()).toBe('2026-10-18T01:00:00.000Z')
  })

  it('leaves kakao-gift rows alone, even with the same external id', async () => {
    await collectGiftCampaigns(now, {
      fetchList: async () => ({
        items: [{ campaignId: '7', campaignTitle: '선물', remainingDays: 3 }],
        totalCount: 1,
        invalid: 0,
      }),
    })
    await collectMusinsaCampaigns(now, { fetchList: fetchList([item(7)]) })
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
