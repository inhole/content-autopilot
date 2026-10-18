import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AsideNotRunningError } from '../src/aside/client.ts'
import {
  CLOUD_QUEUES,
  createLoginAlerter,
  LOCAL_QUEUES,
  runMusinsaCollect,
} from '../src/campaigns/jobs.ts'
import {
  fetchMusinsaList,
  MUSINSA_LIST_SCRIPT,
  MusinsaItemSchema,
  MusinsaListSchema,
  MusinsaLoginError,
  musinsaEventUrl,
  musinsaTitle,
  parseMusinsaEndDate,
} from '../src/campaigns/musinsa.ts'
import { FakeBrowser } from './fake-browser.ts'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/musinsa/recruitment-campaigns.json', import.meta.url), 'utf8'),
)

describe('musinsa schemas', () => {
  it('parses the real list envelope and every item of the fixture', () => {
    const env = MusinsaListSchema.parse(fixture)
    expect(env.data.list.length).toBeGreaterThan(0)
    for (const raw of env.data.list) expect(MusinsaItemSchema.safeParse(raw).success).toBe(true)
  })

  it('keeps unknown fields and rejects an item without a campaign id', () => {
    const ok = MusinsaItemSchema.parse({ ...fixture.data.list[0], extra: 1 })
    expect((ok as Record<string, unknown>).extra).toBe(1)
    expect(MusinsaItemSchema.safeParse({ ...fixture.data.list[0], campaignId: 'x' }).success).toBe(
      false,
    )
  })

  it('builds the campaign page url', () => {
    expect(musinsaEventUrl(38933)).toBe('https://www.musinsa.com/preuser/events/38933')
  })
})

describe('parseMusinsaEndDate', () => {
  it('reads the value as KST wall time', () => {
    expect(parseMusinsaEndDate('2026-10-20T23:59:59').toISOString()).toBe(
      '2026-10-20T14:59:59.000Z',
    )
  })

  it('crosses midnight in UTC correctly', () => {
    expect(parseMusinsaEndDate('2026-10-21T00:30:00').toISOString()).toBe(
      '2026-10-20T15:30:00.000Z',
    )
    expect(parseMusinsaEndDate('2026-01-01T08:59:59').toISOString()).toBe(
      '2025-12-31T23:59:59.000Z',
    )
  })

  it('rejects garbage', () => {
    expect(() => parseMusinsaEndDate('soon')).toThrow()
  })
})

describe('musinsaTitle', () => {
  const item = (goodsCount: number | undefined) =>
    MusinsaItemSchema.parse({
      ...fixture.data.list[0],
      goodsCount,
      representativeGoods: { goodsName: ' 후드 집업 ' },
    })

  it('has no prefix for a single goods', () => {
    expect(musinsaTitle(item(1))).toBe('후드 집업')
    expect(musinsaTitle(item(undefined))).toBe('후드 집업')
  })

  it('prefixes the number of further goods', () => {
    expect(musinsaTitle(item(3))).toBe('[+2] 후드 집업')
  })
})

describe('fetchMusinsaList', () => {
  const items = fixture.data.list

  it('validates the script result', async () => {
    const agent = new FakeBrowser(() => ({
      status: 200,
      items: [...items, { nope: 1 }],
      loggedIn: true,
    }))
    const out = await fetchMusinsaList(agent)
    expect(out.items).toHaveLength(items.length)
    expect(out.invalid).toBe(1)
    expect(agent.scripts[0]).toBe(MUSINSA_LIST_SCRIPT)
  })

  it('throws a Korean login error when logged out', async () => {
    const agent = new FakeBrowser(() => ({ status: 401, items: [], loggedIn: false }))
    const err = await fetchMusinsaList(agent).catch((e) => e)
    expect(err).toBeInstanceOf(MusinsaLoginError)
    expect(err.message).toContain('로그인')
  })

  it('throws on other HTTP errors and on a wholly invalid list', async () => {
    await expect(
      fetchMusinsaList(new FakeBrowser(() => ({ status: 500, items: [], loggedIn: true }))),
    ).rejects.toThrow('HTTP 500')
    await expect(
      fetchMusinsaList(new FakeBrowser(() => ({ status: 200, items: [{}], loggedIn: true }))),
    ).rejects.toThrow('invalid')
  })
})

describe('MUSINSA_LIST_SCRIPT', () => {
  it('is syntactically valid as an async function body', () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    expect(
      () => new AsyncFunction('listBrowserTabs', 'openTab', 'sleep', 'fetch', MUSINSA_LIST_SCRIPT),
    ).not.toThrow()
  })

  it('stays read-only and bounded', () => {
    expect(MUSINSA_LIST_SCRIPT).toContain(
      'influencer.musinsa.com/api2/mcmp/v2/recruitment-campaigns',
    )
    expect(MUSINSA_LIST_SCRIPT).toContain('page < 20')
    expect(MUSINSA_LIST_SCRIPT).not.toMatch(/method|POST|\.click\(|\.fill\(/)
  })
})

describe('login alert', () => {
  it('sends at most once per 12 hours', async () => {
    const sent: string[] = []
    const alert = createLoginAlerter(async (t) => void sent.push(t))
    const t0 = Date.parse('2026-10-18T01:00:00Z')
    expect(await alert('a', t0)).toBe(true)
    expect(await alert('b', t0 + 11 * 3_600_000)).toBe(false)
    expect(await alert('c', t0 + 12 * 3_600_000)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('Aside')
  })
})

describe('runMusinsaCollect', () => {
  const base = () => {
    const calls = { rank: 0, alerts: [] as string[] }
    return {
      calls,
      deps: {
        enqueueRank: async () => void calls.rank++,
        alert: async (r: string) => void calls.alerts.push(r),
      },
    }
  }
  const collected = { fetched: 1, created: [5], updated: 0, invalid: 0, totalCount: 1 }

  it('enqueues the cloud rank after collecting', async () => {
    const { calls, deps } = base()
    const out = await runMusinsaCollect({ ...deps, collect: async () => collected })
    expect(out).toMatchObject({ created: 1 })
    expect(calls.rank).toBe(1)
  })

  it('alerts and ends quietly when logged out or Aside is closed', async () => {
    const a = base()
    expect(
      await runMusinsaCollect({
        ...a.deps,
        collect: async () => {
          throw new MusinsaLoginError()
        },
      }),
    ).toEqual({ skipped: 'logged-out' })
    const b = base()
    expect(
      await runMusinsaCollect({
        ...b.deps,
        collect: async () => {
          throw new AsideNotRunningError()
        },
      }),
    ).toEqual({ skipped: 'aside-not-running' })
    expect(a.calls.alerts).toHaveLength(1)
    expect(b.calls.rank).toBe(0)
  })

  it('rethrows other errors for the queue to retry', async () => {
    const { deps } = base()
    await expect(
      runMusinsaCollect({
        ...deps,
        collect: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
  })
})

describe('worker roles', () => {
  it('local and cloud work disjoint queues', () => {
    expect(LOCAL_QUEUES.filter((q) => CLOUD_QUEUES.includes(q))).toEqual([])
    expect(LOCAL_QUEUES).toEqual(['musinsa-collect'])
    expect(CLOUD_QUEUES).toContain('campaign-rank')
    expect(CLOUD_QUEUES).not.toContain('musinsa-collect')
  })
})
