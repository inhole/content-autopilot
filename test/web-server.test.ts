import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDashboardServer, readCookie } from '../src/web/server.ts'
import { CSRF, fakeAuth, SESSION_HEADERS, TOKEN } from './fake-auth.ts'

const { auth, state } = fakeAuth()
const sent: string[] = []
let failNotify = false

let base = ''
const server = createDashboardServer({
  auth,
  notify: async (text) => {
    if (failNotify) throw new Error('telegram down')
    sent.push(text)
  },
  webDist: null,
  now: () => new Date('2026-10-18T03:00:00Z'),
  loaders: {
    overview: async () => {
      throw new Error('not used')
    },
    campaigns: async () => [],
    campaign: async () => null,
    posts: async () => [],
    insights: async (days) => ({ days, daily: [], top: [] }),
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
beforeEach(() => {
  sent.length = 0
  failNotify = false
  state.actions.length = 0
  state.logins.length = 0
  state.revoked.length = 0
  state.revokedAll = 0
  state.expired = 0
  state.nextCode = { ok: true, code: '123456', expiresAt: new Date('2026-10-18T03:05:00Z') }
})

const loginOk = () => {
  state.nextLogin = {
    ok: true,
    session: { id: 9, token: TOKEN, csrf: CSRF, expiresAt: new Date('2026-11-17T03:00:00Z') },
  }
}

/** A same-origin JSON POST, as the app sends it. */
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('helpers', () => {
  it('reads one cookie among many', () => {
    expect(readCookie('a=1; ca_session=xyz; b=2', 'ca_session')).toBe('xyz')
    expect(readCookie('xca_session=1', 'ca_session')).toBeUndefined()
    expect(readCookie(undefined, 'ca_session')).toBeUndefined()
  })
})

describe('dashboard server', () => {
  it('serves /healthz without auth, with security headers', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  it('405 for writes outside the auth routes, even unauthenticated', async () => {
    for (const p of ['/', '/api/overview']) {
      const res = await fetch(`${base}${p}`, { method: 'POST' })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
    }
    const wrong = await fetch(`${base}/api/auth/login`)
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('POST')
    expect((await fetch(`${base}/api/auth/session`, { method: 'POST' })).status).toBe(405)
  })
  it('503 for app routes without a build', async () => {
    expect((await fetch(`${base}/`)).status).toBe(503)
  })
})

describe('session', () => {
  it('reports no session without a valid cookie', async () => {
    const cookies = ['', 'ca_session=nope', `ca_session=${'c'.repeat(43)}`]
    for (const cookie of cookies) {
      const res = await fetch(`${base}/api/auth/session`, {
        headers: cookie ? { Cookie: cookie } : {},
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ authenticated: false })
    }
  })
  it('returns the CSRF token of a live session', async () => {
    const res = await fetch(`${base}/api/auth/session`, { headers: SESSION_HEADERS })
    expect(await res.json()).toEqual({
      authenticated: true,
      csrf: CSRF,
      expiresAt: '2026-11-17T03:00:00.000Z',
    })
  })
})

describe('write requests must be same-origin JSON', () => {
  const raw = (headers: Record<string, string>) =>
    fetch(`${base}/api/auth/code`, { method: 'POST', headers, body: '{}' })

  it('403 without an origin, from another origin, cross-site or as a form', async () => {
    const json = { 'content-type': 'application/json' }
    for (const headers of [
      json,
      { ...json, origin: 'https://evil.example' },
      { ...json, origin: base, 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      { 'content-type': 'text/plain', origin: base },
    ]) {
      expect((await raw(headers)).status).toBe(403)
    }
    expect(sent).toEqual([])
    expect(state.actions).toEqual([])
  })
  it('accepts the forwarded host of the proxy', async () => {
    const res = await post(
      '/api/auth/code',
      {},
      { origin: 'https://dash.example', 'x-forwarded-host': 'dash.example' },
    )
    expect(res.status).toBe(200)
  })
})

describe('login code', () => {
  it('sends the code to Telegram and records the request', async () => {
    const res = await post('/api/auth/code')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ expiresAt: '2026-10-18T03:05:00.000Z' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('123456')
    expect(sent[0]).toContain('IP: 203.0.113.7')
    expect(state.actions).toEqual([
      { sessionId: null, action: 'code_request', result: 'ok', ip: '203.0.113.7' },
    ])
  })
  it('429 with Retry-After when rate limited; alerts only on the first hourly hit', async () => {
    state.nextCode = { ok: false, reason: 'too_soon', retryAfterS: 42, firstLimitHit: false }
    const soon = await post('/api/auth/code')
    expect(soon.status).toBe(429)
    expect(soon.headers.get('retry-after')).toBe('42')
    expect((await soon.json()).error).toContain('42초')
    expect(sent).toEqual([])

    state.nextCode = { ok: false, reason: 'hourly_limit', retryAfterS: 900, firstLimitHit: true }
    expect((await post('/api/auth/code')).status).toBe(429)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('한도')
    state.nextCode = { ok: false, reason: 'hourly_limit', retryAfterS: 800, firstLimitHit: false }
    await post('/api/auth/code')
    expect(sent).toHaveLength(1)
    expect(state.actions.map((a) => a.result)).toEqual(['too_soon', 'hourly_limit', 'hourly_limit'])
  })
  it('502 and expires the code when Telegram fails', async () => {
    failNotify = true
    const res = await post('/api/auth/code')
    expect(res.status).toBe(502)
    expect(state.expired).toBe(1)
    expect(state.actions.at(-1)?.result).toBe('send_failed')
  })
})

describe('login', () => {
  it('400 for a malformed code or body, without checking it', async () => {
    for (const body of [{}, { code: '12345' }, { code: 123456 }, { code: '12345a' }]) {
      expect((await post('/api/auth/login', body)).status).toBe(400)
    }
    expect((await post('/api/auth/login', '{not json')).status).toBe(400)
    const big = await post('/api/auth/login', { code: '123456', pad: 'x'.repeat(5000) })
    expect(big.status).toBe(400)
    expect(state.logins).toEqual([])
  })
  it('401 with attempts left for a wrong code', async () => {
    state.nextLogin = { ok: false, reason: 'wrong', attemptsLeft: 3 }
    const res = await post('/api/auth/login', { code: '000000' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toContain('3번')
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('429 and an alert when the code locks', async () => {
    state.nextLogin = { ok: false, reason: 'locked' }
    expect((await post('/api/auth/login', { code: '000000' })).status).toBe(429)
    expect(sent[0]).toContain('틀려서')
  })
  it('400 when there is no live code', async () => {
    state.nextLogin = { ok: false, reason: 'no_code' }
    expect((await post('/api/auth/login', { code: '000000' })).status).toBe(400)
  })
  it('sets a strict session cookie, returns the CSRF token and alerts', async () => {
    loginOk()
    const res = await post('/api/auth/login', { code: '123456' }, { 'user-agent': 'test-ua' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authenticated: true,
      csrf: CSRF,
      expiresAt: '2026-11-17T03:00:00.000Z',
    })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`ca_session=${TOKEN}`)
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000'])
      expect(cookie).toContain(flag)
    expect(state.logins).toEqual([{ code: '123456', ip: '203.0.113.7', userAgent: 'test-ua' }])
    expect(state.actions).toEqual([
      { sessionId: 9, action: 'login', result: 'ok', ip: '203.0.113.7' },
    ])
    expect(sent[0]).toContain('관리자 콘솔 로그인')
  })
  it('still logs in when the alert cannot be sent', async () => {
    failNotify = true
    loginOk()
    expect((await post('/api/auth/login', { code: '123456' })).status).toBe(200)
  })
})

describe('logout', () => {
  it('needs a session and its CSRF token', async () => {
    const none = await post('/api/auth/logout', {}, { 'x-csrf-token': CSRF })
    expect(none.status).toBe(401)
    expect(none.headers.get('set-cookie')).toContain('Max-Age=0')
    for (const csrf of [undefined, 'wrong', `${CSRF}x`]) {
      const res = await post(
        '/api/auth/logout',
        {},
        { ...SESSION_HEADERS, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      )
      expect(res.status).toBe(403)
    }
    expect(state.revoked).toEqual([])
  })
  it('revokes the session and clears the cookie', async () => {
    const res = await post('/api/auth/logout', {}, { ...SESSION_HEADERS, 'x-csrf-token': CSRF })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(state.revoked).toEqual([1])
    expect(state.actions.at(-1)).toMatchObject({ sessionId: 1, action: 'logout', result: 'ok' })
  })
  it('logout-all revokes every session and alerts', async () => {
    const res = await post('/api/auth/logout-all', {}, { ...SESSION_HEADERS, 'x-csrf-token': CSRF })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revoked: 2 })
    expect(state.revokedAll).toBe(1)
    expect(sent[0]).toContain('모든 세션(2개)')
    expect(state.actions.at(-1)).toMatchObject({ action: 'logout_all', detail: { revoked: 2 } })
  })
})

describe('public gift hand-off', () => {
  const id = '6a9e80dda960071e0ef70bb2'
  const web = `https://gift.kakao.com/giftbox/trial-campaign/${id}`
  const app = `kakaotalk://inappbrowser?url=${encodeURIComponent(web)}`

  it('serves the page without auth, with exact URLs and strict headers', async () => {
    const res = await fetch(`${base}/go/gift/${id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(app).toBe(
      'kakaotalk://inappbrowser?url=https%3A%2F%2Fgift.kakao.com%2Fgiftbox%2Ftrial-campaign%2F6a9e80dda960071e0ef70bb2',
    )
    expect(html).toContain(`content="0;url=${app}"`)
    expect(html).toContain(`<a class="primary" href="${app}">카카오톡에서 열기</a>`)
    expect(html).toContain(`href="${web}">웹 브라우저로 열기`)
    expect(html).not.toContain('<script')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(`${base}/go/gift/${id}`, { method: 'HEAD' })).status).toBe(200)
  })
  it('ignores query strings and never redirects elsewhere', async () => {
    const res = await fetch(`${base}/go/gift/${id}?url=https://evil.example`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('evil')
  })
  it.each([
    '/go/gift/..%2F..%2Fx',
    '/go/gift/../x',
    `/go/gift/${id.toUpperCase()}`,
    `/go/gift/${id}0`,
    `/go/gift/${id.slice(1)}`,
    `/go/gift/${id}/`,
    '/go/gift/',
    '/go/musinsa/38933',
    '/go/',
  ])('404s %s without auth', async (p) => {
    const res = await fetch(`${base}${p}`)
    expect(res.status).toBe(404)
  })
  it('does not open other routes', async () => {
    expect((await fetch(`${base}/api/campaigns`)).status).toBe(401)
    expect((await fetch(`${base}/api/overview`)).status).toBe(401)
  })
})
