import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  endOfLocalDay,
  fetchMusinsaDetail,
  fetchMusinsaList,
  MusinsaDetailResponseSchema,
  MusinsaItemSchema,
  MusinsaListSchema,
  musinsaEventUrl,
  musinsaProductId,
  parseMusinsaDetail,
  representativeProduct,
} from '../src/campaigns/musinsa.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/musinsa/${name}`, import.meta.url), 'utf8'))
const page1 = fixture('events-page1.json')
const detail = fixture('event-48092.json')
const content = page1.data.content as Record<string, unknown>[]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const asFetch = (fn: unknown) => fn as typeof fetch
const fast = { delayMs: 0, retryDelayMs: 0 }

const event = (id: number, over: Record<string, unknown> = {}) => ({
  ...content[0],
  id,
  products: [{ uniqueId: String(1000 + id), isRepresentative: true }],
  ...over,
})

/** Serves `pages` (arrays of events) as page 1..n; unknown pages answer an empty last page. */
function fakeFetch(pages: unknown[][], opts: { failPage?: number; status?: number } = {}) {
  const calls: string[] = []
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(String(input))
    if (url.pathname.endsWith('/event/count')) return json({ data: 352 })
    const page = Number(url.searchParams.get('page'))
    if (page === opts.failPage) return json({}, opts.status ?? 500)
    const items = pages[page - 1] ?? []
    return json({ data: { content: items, hasNext: page < pages.length } })
  })
  return { impl: asFetch(impl), calls }
}

describe('musinsa schemas', () => {
  it('parses the real list envelope and every item of the fixture', () => {
    const env = MusinsaListSchema.parse(page1)
    expect(env.data.content).toHaveLength(20)
    expect(env.data.hasNext).toBe(true)
    for (const raw of env.data.content) expect(MusinsaItemSchema.safeParse(raw).success).toBe(true)
  })

  it('keeps unknown fields and rejects bad ids and dates', () => {
    const ok = MusinsaItemSchema.parse({ ...content[0], extra: 1 })
    expect((ok as Record<string, unknown>).extra).toBe(1)
    expect(MusinsaItemSchema.safeParse({ ...content[0], id: 'x' }).success).toBe(false)
    expect(MusinsaItemSchema.safeParse({ ...content[0], endDate: '10/25' }).success).toBe(false)
    expect(MusinsaItemSchema.safeParse({ ...content[0], state: undefined }).success).toBe(false)
  })

  it('parses the real detail response', () => {
    expect(MusinsaDetailResponseSchema.safeParse(detail).success).toBe(true)
  })

  it('builds the campaign page url from the event id', () => {
    expect(musinsaEventUrl(48092)).toBe('https://www.musinsa.com/preuser/events/48092')
  })
})

describe('mapping helpers', () => {
  it('picks the representative product, else the first', () => {
    const item = MusinsaItemSchema.parse(content[0])
    expect(representativeProduct(item)?.uniqueId).toBe('7529016')
    const none = MusinsaItemSchema.parse(
      event(1, { products: [{ uniqueId: 'a' }, { uniqueId: '2' }] }),
    )
    expect(representativeProduct(none)?.uniqueId).toBe('a')
  })

  it('turns the uniqueId into a numeric product id, or null', () => {
    expect(musinsaProductId(MusinsaItemSchema.parse(content[0]))).toBe(7529016)
    expect(musinsaProductId(MusinsaItemSchema.parse(event(1, { products: [] })))).toBeNull()
    expect(
      musinsaProductId(MusinsaItemSchema.parse(event(1, { products: [{ uniqueId: 'x1' }] }))),
    ).toBeNull()
  })
})

describe('endOfLocalDay (KST date math)', () => {
  it('is 23:59:59.999 KST of the given day', () => {
    expect(endOfLocalDay('2026-10-25', 'Asia/Seoul').toISOString()).toBe('2026-10-25T14:59:59.999Z')
  })

  it('crosses the year and month ends', () => {
    expect(endOfLocalDay('2026-12-31', 'Asia/Seoul').toISOString()).toBe('2026-12-31T14:59:59.999Z')
    expect(endOfLocalDay('2026-03-01', 'Asia/Seoul').toISOString()).toBe('2026-03-01T14:59:59.999Z')
  })

  it('rejects garbage', () => {
    expect(() => endOfLocalDay('soon', 'Asia/Seoul')).toThrow()
    expect(() => endOfLocalDay('2026-10-25T00:00:00', 'Asia/Seoul')).toThrow()
  })
  it('reads Musinsa dates as KST days by default, not in TZ_NAME', () => {
    expect(endOfLocalDay('2026-10-25').toISOString()).toBe('2026-10-25T14:59:59.999Z')
  })
})

describe('parseMusinsaDetail', () => {
  it('keeps the category, dates, member level and drops NONE options', () => {
    expect(parseMusinsaDetail(detail)).toEqual({
      eventCategory: 'FASHION_ACCESSORY',
      winnerDrawDate: '2026-10-27',
      deliveryDate: '2026-10-29',
      reviewStartDate: '2026-10-31',
      reviewEndDate: '2026-11-14',
      minimumMemberLevel: 2,
    })
  })

  it('collects option names as "option: value"', () => {
    const body = {
      data: {
        eventId: 1,
        products: [
          {
            optionItems: [
              { optionValues: [{ name: '블랙', optionName: '색상' }] },
              {
                optionValues: [
                  { name: '블랙', optionName: '색상' },
                  { name: 'L', optionName: '사이즈' },
                ],
              },
              { optionValues: [{ name: 'NONE', optionName: 'NONE' }] },
            ],
          },
        ],
      },
    }
    expect(parseMusinsaDetail(body).optionNames).toEqual(['색상: 블랙', '사이즈: L'])
  })

  it('ignores a malformed date instead of failing', () => {
    const body = { data: { eventId: 1, reviewEndDate: 'tomorrow', eventCategory: 'TOP' } }
    expect(parseMusinsaDetail(body)).toEqual({ eventCategory: 'TOP' })
  })

  it('fetches /events/:id', async () => {
    const impl = vi.fn(async (_url: string) => json(detail))
    const out = await fetchMusinsaDetail(48092, { fetch: asFetch(impl), ...fast })
    expect(out.reviewEndDate).toBe('2026-11-14')
    expect(String(impl.mock.calls[0]?.[0])).toBe(
      'https://www.musinsa.com/preuser/api/v1/event/events/48092',
    )
  })
})

describe('fetchMusinsaList', () => {
  it('reads pages 1.. with size 100 until hasNext is false', async () => {
    const { impl, calls } = fakeFetch([[event(1), event(2)], [event(3)], [event(4)]])
    const out = await fetchMusinsaList({ fetch: impl, ...fast })
    expect(out.items.map((i) => i.id)).toEqual([1, 2, 3, 4])
    expect(out.totalCount).toBe(352)
    const pageCalls = calls.filter((c) => c.includes('/events?'))
    expect(pageCalls).toEqual([
      'https://www.musinsa.com/preuser/api/v1/event/events?page=1&size=100',
      'https://www.musinsa.com/preuser/api/v1/event/events?page=2&size=100',
      'https://www.musinsa.com/preuser/api/v1/event/events?page=3&size=100',
    ])
  })

  it('keeps only OPEN items, dedupes by id and counts invalid ones', async () => {
    const { impl } = fakeFetch([
      [event(1), event(2, { state: 'CLOSED' }), { nope: 1 }],
      [event(1), event(3)],
    ])
    const out = await fetchMusinsaList({ fetch: impl, ...fast })
    expect(out.items.map((i) => i.id)).toEqual([1, 3])
    expect(out.invalid).toBe(1)
  })

  it('stops on an empty page even when hasNext lies', async () => {
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/count')) return json({ data: 1 })
      const page = Number(url.searchParams.get('page'))
      return json({ data: { content: page === 1 ? [event(1)] : [], hasNext: true } })
    })
    const out = await fetchMusinsaList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(1)
    expect(impl.mock.calls.filter((c) => String(c[0]).includes('/events?'))).toHaveLength(2)
  })

  it('stops at the page cap when hasNext never ends', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/count')) return json({ data: 1 })
      const page = Number(url.searchParams.get('page'))
      return json({ data: { content: [event(page)], hasNext: true } })
    })
    const out = await fetchMusinsaList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(20)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('20-page cap'))
    warn.mockRestore()
  })

  it('throws when the first page fails', async () => {
    const { impl } = fakeFetch([[event(1)]], { failPage: 1, status: 403 })
    await expect(fetchMusinsaList({ fetch: impl, ...fast })).rejects.toThrow('403')
  })

  it('retries a 5xx once, then succeeds', async () => {
    let n = 0
    const impl = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith('/count')) return json({ data: 1 })
      return ++n === 1 ? json({}, 503) : json({ data: { content: [event(1)], hasNext: false } })
    })
    const out = await fetchMusinsaList({ fetch: asFetch(impl), ...fast })
    expect(out.items).toHaveLength(1)
  })

  it('keeps earlier pages when a later page fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { impl } = fakeFetch([[event(1)], [event(2)], [event(3)]], { failPage: 2, status: 400 })
    const out = await fetchMusinsaList({ fetch: impl, ...fast })
    expect(out.items.map((i) => i.id)).toEqual([1])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page 2 failed'))
    warn.mockRestore()
  })

  it('throws when every item of the first page is invalid (shape changed)', async () => {
    const { impl } = fakeFetch([[{ a: 1 }, { b: 2 }]])
    await expect(fetchMusinsaList({ fetch: impl, ...fast })).rejects.toThrow('invalid')
  })

  it('does not fail when the count endpoint does', async () => {
    const impl = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith('/count')
        ? json({}, 500)
        : json({ data: { content: [event(1)], hasNext: false } }),
    )
    const out = await fetchMusinsaList({ fetch: asFetch(impl), ...fast })
    expect(out.totalCount).toBeNull()
  })
})
