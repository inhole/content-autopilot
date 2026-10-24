import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Campaign } from '../src/campaigns/types.ts'
import type { CampaignListRow } from '../src/web/data.ts'
import { createDashboardServer, type DashboardLoaders } from '../src/web/server.ts'
import { fakeActions } from './fake-actions.ts'
import { fakeAuth, SESSION_HEADERS } from './fake-auth.ts'

const A = SESSION_HEADERS
const NOW = new Date('2026-10-18T03:00:00Z')

const calls: { campaigns: unknown[]; posts: number[]; insights: unknown[] } = {
  campaigns: [],
  posts: [],
  insights: [],
}

const row = (over: Partial<CampaignListRow>): CampaignListRow => ({
  id: 1,
  source: 'kakao-gift',
  title: 'gift',
  brand: 'b',
  status: 'PENDING_REVIEW',
  recruit_count: 10,
  application_count: 250,
  apply_deadline: new Date('2026-10-20T14:59:59Z'),
  review_deadline: null,
  score: 80,
  updated_at: new Date('2026-10-17T00:00:00Z'),
  price: 49000,
  ...over,
})

const loaders: DashboardLoaders = {
  overview: async () => ({
    posts: {
      pendingReview: 2,
      scheduled: [{ id: 5, text: 'x', scheduled_at: new Date('2026-10-18T09:00:00Z') }],
      published24h: 1,
      failed: 0,
    },
    campaigns: {
      counts: { APPLIED: 3 },
      lastCollectedAt: new Date('2026-10-18T01:00:00Z'),
      lastSeenCount: 4,
      postedLast30d: 1,
      bySource: {},
    },
  }),
  campaigns: async (filter, source) => {
    calls.campaigns.push([filter, source])
    return [
      row({}),
      row({
        id: 2,
        source: 'musinsa',
        recruit_count: null,
        application_count: null,
        price: null,
      }),
      row({ id: 3, status: 'SELECTED', apply_deadline: null, review_deadline: null }),
    ]
  },
  campaign: async (id) => {
    if (id === 500) throw new Error('db down')
    if (id !== 7) return null
    return {
      campaign: { id: 7, title: 'seven', created_at: new Date('2026-10-01T00:00:00Z') } as Campaign,
      reminders: [{ kind: 'review-d3', sent_at: new Date('2026-10-17T00:00:00Z') }],
    }
  },
  posts: async (limit) => {
    calls.posts.push(limit)
    return [
      {
        id: 1,
        status: 'PUBLISHED',
        text: 'hi',
        scheduled_at: null,
        published_at: new Date('2026-10-17T00:00:00Z'),
        views: 10,
        likes: 1,
        replies: 0,
        origin: 'revived',
      },
    ]
  },
  insights: async (days, now) => {
    calls.insights.push([days, now.toISOString()])
    return {
      days,
      daily: [{ date: '2026-10-17', posts: 1, views: 10, likes: 1, replies: 0 }],
      top: [
        {
          id: 1,
          text: 'hi',
          published_at: new Date('2026-10-17T00:00:00Z'),
          views: 10,
          likes: 1,
          replies: 0,
          reposts: null,
        },
      ],
    }
  },
}

const tmp = mkdtempSync(path.join(tmpdir(), 'dash-dist-'))
const missingDist = path.join(tmp, 'missing')
const buildDir = path.join(tmp, 'web', 'dist')
mkdirSync(path.join(buildDir, 'assets'), { recursive: true })
writeFileSync(path.join(buildDir, 'index.html'), '<!doctype html><title>app</title><div id=root>')
writeFileSync(path.join(buildDir, 'assets', 'app-abc123.js'), 'console.log(1)')
writeFileSync(path.join(buildDir, 'assets', 'app-abc123.css'), 'a{}')
writeFileSync(path.join(buildDir, 'favicon.svg'), '<svg/>')
writeFileSync(path.join(buildDir, 'font.woff2'), 'f')
writeFileSync(path.join(tmp, 'web', 'secret.txt'), 'secret')

let appBase = ''
let legacyBase = ''
const notify = async () => {}
const app = createDashboardServer({
  loaders,
  auth: fakeAuth().auth,
  actions: fakeActions().actions,
  notify,
  now: () => NOW,
  webDist: buildDir,
})
const legacy = createDashboardServer({
  loaders,
  auth: fakeAuth().auth,
  actions: fakeActions().actions,
  notify,
  now: () => NOW,
  webDist: missingDist,
})

const listen = async (s: ReturnType<typeof createDashboardServer>) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
beforeAll(async () => {
  appBase = await listen(app)
  legacyBase = await listen(legacy)
})
afterAll(async () => {
  for (const s of [app, legacy]) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
  rmSync(tmp, { recursive: true, force: true })
})

const get = (p: string, base = appBase, headers: Record<string, string> = A) =>
  fetch(`${base}${p}`, { headers })

/** Raw request so the client cannot normalize `..` out of the path. */
function raw(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () =>
      s.write(
        `GET ${target} HTTP/1.1\r\nHost: x\r\nCookie: ${A.Cookie}\r\nConnection: close\r\n\r\n`,
      ),
    )
    let data = ''
    s.on('data', (d) => {
      data += d
    })
    s.on('end', () =>
      resolve({
        status: Number(/^HTTP\/1.1 (\d+)/.exec(data)?.[1]),
        body: data.split('\r\n\r\n')[1] ?? '',
      }),
    )
    s.on('error', reject)
  })
}

describe('api', () => {
  it('requires a live session on every /api route', async () => {
    const stale = { Cookie: `ca_session=${'b'.repeat(43)}` }
    const malformed = { Cookie: 'ca_session=short' }
    for (const p of [
      '/api/overview',
      '/api/campaigns',
      '/api/campaigns/7',
      '/api/posts',
      '/api/insights',
      '/api/nope',
    ]) {
      for (const headers of [{}, stale, malformed]) {
        const res = await get(p, appBase, headers)
        expect(res.status, p).toBe(401)
        expect(await res.json()).toEqual({ error: '로그인이 필요해요' })
      }
    }
  })
  it('json headers', async () => {
    const res = await get('/api/overview')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })
  it('overview with ISO dates', async () => {
    const body = await (await get('/api/overview')).json()
    expect(body.posts.scheduled[0].scheduled_at).toBe('2026-10-18T09:00:00.000Z')
    expect(body.campaigns.lastCollectedAt).toBe('2026-10-18T01:00:00.000Z')
    expect(body.campaigns.counts).toEqual({ APPLIED: 3 })
  })
  it('campaign list adds deadline, estimate flag and competition', async () => {
    const body = await (await get('/api/campaigns?status=APPLIED&source=musinsa')).json()
    expect(body.filter).toEqual({ status: 'APPLIED', source: 'musinsa' })
    expect(calls.campaigns.at(-1)).toEqual(['APPLIED', 'musinsa'])
    const [gift, musinsa, none] = body.rows
    expect(gift.next_deadline).toEqual({
      at: '2026-10-20T14:59:59.000Z',
      kind: 'apply',
      estimated: true,
    })
    expect(gift.competition).toBe(25)
    expect(gift.price).toBe(49000)
    expect(musinsa.price).toBeNull()
    expect(gift.updated_at).toBe('2026-10-17T00:00:00.000Z')
    expect(musinsa.next_deadline.estimated).toBe(false)
    expect(musinsa.competition).toBeNull()
    expect(none.next_deadline).toBeNull()
  })
  it('campaign list falls back to defaults for unknown params', async () => {
    const body = await (await get('/api/campaigns?status=NOPE&source=x')).json()
    expect(body.filter).toEqual({ status: 'active', source: null })
  })
  it('campaign detail: ok, 404 for unknown / non-numeric ids, 500 without details', async () => {
    const ok = await get('/api/campaigns/7')
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.campaign.created_at).toBe('2026-10-01T00:00:00.000Z')
    expect(body.reminders[0].sent_at).toBe('2026-10-17T00:00:00.000Z')
    for (const p of [
      '/api/campaigns/42',
      '/api/campaigns/abc',
      '/api/campaigns/1x',
      '/api/campaigns/-1',
    ]) {
      const res = await get(p)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
    const err = await get('/api/campaigns/500')
    expect(err.status).toBe(500)
    expect(await err.text()).not.toContain('db down')
  })
  it('posts include origin and clamp limit', async () => {
    const body = await (await get('/api/posts?limit=9999')).json()
    expect(calls.posts.at(-1)).toBe(200)
    expect(body.rows[0].origin).toBe('revived')
    expect(body.rows[0].published_at).toBe('2026-10-17T00:00:00.000Z')
    await get('/api/posts?limit=0')
    expect(calls.posts.at(-1)).toBe(1)
    await get('/api/posts?limit=abc')
    expect(calls.posts.at(-1)).toBe(50)
    await get('/api/posts')
    expect(calls.posts.at(-1)).toBe(50)
  })
  it('insights clamp days and serialize dates', async () => {
    const body = await (await get('/api/insights?days=1000')).json()
    expect(body.days).toBe(90)
    expect(calls.insights.at(-1)).toEqual([90, NOW.toISOString()])
    expect((await (await get('/api/insights?days=2')).json()).days).toBe(7)
    expect((await (await get('/api/insights')).json()).days).toBe(30)
    expect(body.top[0].published_at).toBe('2026-10-17T00:00:00.000Z')
  })
  it('unknown api path 404 json; non-GET 405 json', async () => {
    const res = await get('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    const post = await fetch(`${appBase}/api/overview`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(await post.json()).toEqual({ error: 'method not allowed' })
  })
  it('api also works when the build is missing', async () => {
    expect((await get('/api/overview', legacyBase)).status).toBe(200)
  })
})

describe('react build serving', () => {
  const APP_CSP_PARTS = [
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    'https://image.msscdn.net',
    "frame-ancestors 'none'",
  ]
  it('serves hashed assets with content types and long cache', async () => {
    const js = await get('/assets/app-abc123.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await js.text()).toBe('console.log(1)')
    const css = await get('/assets/app-abc123.css')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await get('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml')
    expect((await get('/font.woff2')).headers.get('content-type')).toBe('font/woff2')
    expect((await get('/favicon.svg')).headers.get('cache-control')).toBe('no-store')
  })
  it('serves the app shell without a session (it holds no data)', async () => {
    expect((await get('/assets/app-abc123.js', appBase, {})).status).toBe(200)
    expect((await get('/', appBase, {})).status).toBe(200)
    expect((await get('/login', appBase, {})).status).toBe(200)
    expect((await get('/healthz', appBase, {})).status).toBe(200)
  })
  it('falls back to index.html for client routes, with the app CSP', async () => {
    for (const p of ['/', '/campaigns', '/campaigns/7', '/posts', '/insights']) {
      const res = await get(p)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toContain('<div id=root>')
      const csp = res.headers.get('content-security-policy') ?? ''
      for (const part of APP_CSP_PARTS) expect(csp).toContain(part)
      expect(csp).not.toContain("script-src 'unsafe-inline'")
    }
  })
  it('404s a missing asset instead of serving index.html', async () => {
    expect((await get('/assets/missing.js')).status).toBe(404)
    expect((await get('/robots.txt')).status).toBe(404)
  })
  it('HEAD has no body', async () => {
    const res = await fetch(`${appBase}/assets/app-abc123.js`, { method: 'HEAD', headers: A })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
  it('rejects path traversal', async () => {
    const port = Number(new URL(appBase).port)
    for (const target of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/%00',
      '/%zz',
    ]) {
      const res = await raw(port, target)
      expect(res.body, target).not.toContain('secret')
      expect([200, 400, 404], target).toContain(res.status)
    }
  })
})

describe('without a build', () => {
  it('answers 503 for app routes', async () => {
    for (const p of ['/', '/posts', '/nope']) {
      const res = await get(p, legacyBase)
      expect(res.status).toBe(503)
      expect(await res.text()).toContain('build:web')
    }
  })
})
