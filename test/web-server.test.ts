import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDashboardServer, isAuthorized, passwordMatches } from '../src/web/server.ts'

const PASSWORD = 's3cret'
const auth = (pw: string) => ({
  Authorization: `Basic ${Buffer.from(`me:${pw}`).toString('base64')}`,
})

let base = ''
const server = createDashboardServer({
  password: PASSWORD,
  now: () => new Date('2026-10-18T03:00:00Z'),
  loaders: {
    overview: async () => ({
      posts: { pendingReview: 1, scheduled: [], published24h: 0, failed: 0 },
      campaignCounts: {},
      heartbeats: [],
    }),
    campaigns: async () => [],
    campaign: async (id) => {
      if (id === 500) throw new Error('db down')
      return null
    },
    posts: async () => [],
  },
})

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

describe('auth helpers', () => {
  it('compares passwords of any length without throwing', () => {
    expect(passwordMatches('a', 'a')).toBe(true)
    expect(passwordMatches('a', 'abc')).toBe(false)
    expect(passwordMatches('', 'abc')).toBe(false)
  })
  it('rejects malformed headers', () => {
    expect(isAuthorized(undefined, 'x')).toBe(false)
    expect(isAuthorized('Bearer abc', 'x')).toBe(false)
    expect(isAuthorized(`Basic ${Buffer.from('nocolon').toString('base64')}`, 'nocolon')).toBe(
      false,
    )
    expect(isAuthorized(auth('x').Authorization, 'x')).toBe(true)
  })
})

describe('dashboard server', () => {
  it('serves /healthz without auth', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
  it('401 without or with a wrong password', async () => {
    for (const headers of [{}, auth('nope')]) {
      const res = await fetch(`${base}/`, { headers })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Basic realm="content-autopilot"')
    }
  })
  it('serves pages with security headers when authorized', async () => {
    const res = await fetch(`${base}/`, { headers: auth(PASSWORD) })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await res.text()).toContain('현황')
    for (const p of ['/campaigns', '/campaigns?status=all', '/posts']) {
      expect((await fetch(`${base}${p}`, { headers: auth(PASSWORD) })).status).toBe(200)
    }
  })
  it('405 for non-GET methods, even unauthenticated', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })
  it('404 for unknown paths and campaign ids', async () => {
    for (const p of ['/nope', '/campaigns/abc', '/campaigns/1x', '/campaigns/42']) {
      expect((await fetch(`${base}${p}`, { headers: auth(PASSWORD) })).status).toBe(404)
    }
  })
  it('500 page without leaking the error', async () => {
    const res = await fetch(`${base}/campaigns/500`, { headers: auth(PASSWORD) })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('db down')
  })
  it('HEAD returns no body', async () => {
    const res = await fetch(`${base}/`, { method: 'HEAD', headers: auth(PASSWORD) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
