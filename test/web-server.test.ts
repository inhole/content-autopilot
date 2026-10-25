import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDashboardServer, readCookie } from '../src/web/server.ts'
import { fakeActions } from './fake-actions.ts'
import { CSRF, fakeAuth, SESSION_HEADERS, TOKEN } from './fake-auth.ts'
import { fakePostActions } from './fake-post-actions.ts'

const { auth, state } = fakeAuth()
const { actions, state: actionState } = fakeActions()
const { actions: postActions, state: postState } = fakePostActions()
const sent: string[] = []
const opsRuns: string[] = []
let opsQueued = true
let failNotify = false
const profileCalls: string[] = []
let profileStale = false
let profileThrows = false
const scheduleCalls: string[] = []
let scheduleStale = false
let scheduleThrows = false
let scheduleApplied = true
const scheduleResponse = () => ({
  ok: true as const,
  applied: scheduleApplied,
  schedule: {
    current: {
      threadsCollect: { cron: '0 6 * * *', daily: { minute: 0, hours: [6] } },
      giftCollect: { cron: '0 9 * * *', daily: { minute: 0, hours: [9] } },
      musinsaCollect: { cron: '*/5 * * * *', daily: null },
      dailyPostCount: 3,
      publishSlots: ['08:00'],
      campaignDailyMax: 5,
    },
    defaults: {
      threadsCollect: { cron: '0 6 * * *', daily: { minute: 0, hours: [6] } },
      giftCollect: { cron: '0 9 * * *', daily: { minute: 0, hours: [9] } },
      musinsaCollect: { cron: '*/5 * * * *', daily: null },
      dailyPostCount: 3,
      publishSlots: ['08:00'],
      campaignDailyMax: 5,
    },
    source: 'db' as const,
    revision: 7,
  },
})
const profileResponse = {
  ok: true as const,
  profile: {
    about: 'a',
    interests: [],
    preferKeywords: [],
    excludeKeywords: [],
    excludeBrands: [],
    maxCompetition: null,
    minPriceWon: null,
    review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
    disclosure: null,
    source: 'db' as const,
    revision: 4,
  },
}

let base = ''
const server = createDashboardServer({
  auth,
  actions,
  postActions,
  runOps: async (name) => {
    opsRuns.push(name)
    return opsQueued
  },
  profileEdit: {
    save: async (profile, revision) => {
      profileCalls.push(`save:${revision}:${profile.about}`)
      if (profileThrows) throw new Error('db down')
      return profileStale ? null : profileResponse
    },
    reset: async (revision) => {
      profileCalls.push(`reset:${revision}`)
      if (profileThrows) throw new Error('db down')
      return profileStale ? null : profileResponse
    },
  },
  scheduleEdit: {
    save: async (schedule, revision) => {
      scheduleCalls.push(`save:${revision}:${schedule.giftCollect.hours.join(',')}`)
      if (scheduleThrows) throw new Error('db down')
      return scheduleStale ? null : scheduleResponse()
    },
    reset: async (revision) => {
      scheduleCalls.push(`reset:${revision}`)
      if (scheduleThrows) throw new Error('db down')
      return scheduleStale ? null : scheduleResponse()
    },
  },
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
    post: async (id) => (id === 12 ? ({ post: { id: 12 }, parts: [], limits: {} } as never) : null),
    revivable: async () => ({ rows: [] }),
    ops: async () => {
      throw new Error('not used')
    },
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

describe('post actions', () => {
  const auth_ = { ...SESSION_HEADERS, 'x-csrf-token': CSRF }
  const ok = (path: string, body: unknown, headers: Record<string, string> = auth_) =>
    post(path, body, headers)
  const AT = '2026-10-18T09:00:00.000Z'
  const BODIES: [string, unknown][] = [
    ['approve', { revision: 2 }],
    ['reject', { revision: 2, reason: 'boring' }],
    ['regenerate', { revision: 3, feedback: '더 짧게' }],
    ['edit', { revision: 3, idx: 2, text: '내가 고친 답글' }],
    ['deletePart', { revision: 3, idx: 3 }],
    ['unschedule', { scheduledAt: AT }],
    ['publishNow', { scheduledAt: AT }],
    ['retryParts', {}],
    ['revive', {}],
  ]
  const COLLECTION: [string, unknown][] = [
    ['/api/posts/add', { url: 'https://example.com/a', note: '내 의견' }],
    ['/api/revivable/check', {}],
    ['/api/digest', {}],
  ]

  beforeEach(() => {
    postState.calls.length = 0
    postState.next = undefined
    postState.nextAdd = undefined
    postState.fail = undefined
  })

  it.each([
    ...BODIES.map(([n, b]) => [`/api/posts/12/${n}`, b] as [string, unknown]),
    ...COLLECTION,
  ])('%s needs same-origin JSON, a session and the CSRF token', async (path, body) => {
    const noOrigin = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth_ },
      body: JSON.stringify(body),
    })
    expect(noOrigin.status).toBe(403)
    expect((await ok(path, body, { ...auth_, origin: 'https://evil.example' })).status).toBe(403)
    expect((await ok(path, body, {})).status).toBe(401)
    expect((await ok(path, body, SESSION_HEADERS)).status).toBe(403)
    expect(
      (await ok(path, body, { ...SESSION_HEADERS, 'x-csrf-token': 'x'.repeat(43) })).status,
    ).toBe(403)
    expect(postState.calls).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('answers 405 with Allow: POST to GET and other methods', async () => {
    for (const path of [
      '/api/posts/12/approve',
      '/api/posts/add',
      '/api/revivable/check',
      '/api/digest',
    ]) {
      const get = await fetch(`${base}${path}`, { headers: SESSION_HEADERS })
      expect(get.status, path).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
      expect((await fetch(`${base}${path}`, { method: 'DELETE' })).status).toBe(405)
    }
  })

  it('runs the action with the validated body, returns the detail and audits it', async () => {
    const res = await ok('/api/posts/12/reject', { revision: 2, reason: 'boring' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      telegramSynced: true,
      detail: { post: { id: 12 }, parts: [], limits: {} },
    })
    expect(postState.calls).toEqual([
      { name: 'reject', id: 12, params: { revision: 2, reason: 'boring' } },
    ])
    expect(state.actions.at(-1)).toMatchObject({
      sessionId: 1,
      action: 'post.reject',
      target: 'post:12',
      result: 'ok',
      ip: '203.0.113.7',
      detail: { reason: 'boring', telegramSynced: true },
    })
  })

  it('passes each body to the matching action and never audits free text', async () => {
    for (const [name, body] of BODIES) {
      expect((await ok(`/api/posts/12/${name}`, body)).status, name).toBe(200)
    }
    expect(postState.calls.map((c) => c.name)).toEqual(BODIES.map(([n]) => n))
    const sched = postState.calls.find((c) => c.name === 'unschedule')?.params as {
      scheduledAt: Date
    }
    expect(sched.scheduledAt).toBeInstanceOf(Date)
    expect(sched.scheduledAt.toISOString()).toBe(AT)
    const audits = JSON.stringify(state.actions)
    expect(audits).not.toContain('내가 고친 답글')
    expect(audits).not.toContain('더 짧게')
    expect(state.actions.find((a) => a.action === 'post.edit')?.detail).toMatchObject({
      idx: 2,
      chars: 8,
    })
    expect(state.actions.find((a) => a.action === 'post.regenerate')?.detail).toMatchObject({
      feedback: true,
    })
    expect(state.actions.find((a) => a.action === 'post.publishNow')?.detail).toMatchObject({
      scheduledAt: AT,
    })
  })

  it('409 stale, 404 and 400 with the action message', async () => {
    postState.next = { ok: false, reason: 'stale', message: '이미 처리됐어요' }
    const stale = await ok('/api/posts/12/approve', { revision: 2 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: '이미 처리됐어요', stale: true })
    expect(state.actions.at(-1)).toMatchObject({ action: 'post.approve', result: 'stale' })

    postState.next = { ok: false, reason: 'not_found', message: 'x' }
    expect((await ok('/api/posts/999/approve', { revision: 2 })).status).toBe(404)
    expect(state.actions.at(-1)).toMatchObject({ target: 'post:999', result: 'not_found' })
    expect((await ok('/api/posts/abc/approve', { revision: 2 })).status).toBe(404)

    postState.next = { ok: false, reason: 'invalid', message: '501자예요' }
    const bad = await ok('/api/posts/12/edit', { revision: 1, idx: 1, text: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '501자예요' })
  })

  it('400 for an invalid body, without running the action', async () => {
    const bad: [string, unknown][] = [
      ['approve', {}],
      ['approve', { revision: -1 }],
      ['reject', { revision: 2, reason: 'nope' }],
      ['regenerate', { revision: 2, feedback: 'x'.repeat(1001) }],
      ['edit', { revision: 2, idx: 0, text: 'x' }],
      ['edit', { revision: 2, idx: 4, text: 'x' }],
      ['edit', { revision: 2, idx: 1, text: 'x'.repeat(2001) }],
      ['deletePart', { revision: 2, idx: 1 }],
      ['unschedule', { scheduledAt: 'not a date' }],
      ['publishNow', {}],
      ['retryParts', []],
    ]
    for (const [name, body] of bad) {
      const res = await ok(`/api/posts/12/${name}`, body)
      expect(res.status, `${name} ${JSON.stringify(body)}`).toBe(400)
    }
    expect((await ok('/api/posts/12/approve', '{not json')).status).toBe(400)
    expect(postState.calls).toEqual([])
    expect(state.actions.every((a) => a.result === 'invalid')).toBe(true)
  })

  it('500 and an error audit row when the action throws', async () => {
    postState.fail = new Error('db down')
    const res = await ok('/api/posts/12/approve', { revision: 2 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
    expect(state.actions.at(-1)).toMatchObject({ action: 'post.approve', result: 'error' })
  })

  it('adds a topic: 200, 409 when already covered, 400 for a bad url', async () => {
    const res = await ok('/api/posts/add', { url: 'https://example.com/a', note: '내 의견' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, topicId: 77 })
    expect(postState.calls).toEqual([
      { name: 'addTopic', params: { url: 'https://example.com/a', note: '내 의견' } },
    ])
    expect(state.actions.at(-1)).toMatchObject({ action: 'post.add', target: null, result: 'ok' })
    expect(JSON.stringify(state.actions)).not.toContain('내 의견')

    postState.nextAdd = { ok: false, reason: 'covered', postId: 5, status: 'PUBLISHED' }
    const dup = await ok('/api/posts/add', { url: 'https://example.com/a' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: '이미 다룬 기사예요 (#5, PUBLISHED)', postId: 5 })

    postState.calls.length = 0
    for (const body of [
      {},
      { url: 'ftp://example.com' },
      { url: 'javascript:alert(1)' },
      { url: 'not a url' },
      { url: `https://example.com/${'a'.repeat(2000)}` },
      { url: 'https://example.com', note: 'x'.repeat(501) },
    ]) {
      expect((await ok('/api/posts/add', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(postState.calls).toEqual([])
  })

  it('queues revive-check and digest with 202', async () => {
    const check = await ok('/api/revivable/check', {})
    expect(check.status).toBe(202)
    expect(await check.json()).toEqual({ ok: true })
    expect((await ok('/api/digest', {})).status).toBe(202)
    expect(postState.calls.map((c) => c.name)).toEqual(['reviveCheck', 'digest'])
    expect(state.actions.map((a) => a.action)).toEqual(['revive.check', 'digest.build'])
  })
})

describe('campaign actions', () => {
  const auth_ = { ...SESSION_HEADERS, 'x-csrf-token': CSRF }
  const ok = (path: string, body: unknown, headers: Record<string, string> = auth_) =>
    post(path, body, headers)
  const BODIES: [string, unknown][] = [
    ['apply', { revision: 2 }],
    ['reject', { revision: 2, reason: 'brand' }],
    ['result', { selected: true }],
    ['deadline', { status: 'SELECTED', date: '10/30' }],
    ['memo', { status: 'SELECTED', revision: 0, memo: '일주일 써봄' }],
    ['regenerate', { revision: 3, feedback: '더 짧게' }],
    ['draft', { revision: 3, text: '내가 고친 글' }],
    ['posted', { revision: 3 }],
  ]

  beforeEach(() => {
    actionState.calls.length = 0
    actionState.next = undefined
    actionState.fail = undefined
  })

  it.each(BODIES)('%s needs same-origin JSON, a session and the CSRF token', async (name, body) => {
    const path = `/api/campaigns/12/${name}`
    // No Origin header.
    const noOrigin = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth_ },
      body: JSON.stringify(body),
    })
    expect(noOrigin.status).toBe(403)
    // Other origin.
    expect((await ok(path, body, { ...auth_, origin: 'https://evil.example' })).status).toBe(403)
    // No session.
    expect((await ok(path, body, {})).status).toBe(401)
    // Session without CSRF, and with a wrong one.
    expect((await ok(path, body, SESSION_HEADERS)).status).toBe(403)
    expect(
      (await ok(path, body, { ...SESSION_HEADERS, 'x-csrf-token': 'x'.repeat(43) })).status,
    ).toBe(403)
    expect(actionState.calls).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('answers 405 to GET and other methods', async () => {
    const get = await fetch(`${base}/api/campaigns/12/apply`, { headers: SESSION_HEADERS })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    const del = await fetch(`${base}/api/campaigns/12/apply`, { method: 'DELETE' })
    expect(del.status).toBe(405)
  })

  it('runs the action with the validated body and records the audit row', async () => {
    const res = await ok('/api/campaigns/12/reject', { revision: 2, reason: 'brand' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, telegramSynced: true, detail: null })
    expect(actionState.calls).toEqual([
      { name: 'reject', id: 12, params: { revision: 2, reason: 'brand' } },
    ])
    expect(state.actions.at(-1)).toMatchObject({
      sessionId: 1,
      action: 'campaign.reject',
      target: 'campaign:12',
      result: 'ok',
      ip: '203.0.113.7',
      detail: { reason: 'brand', telegramSynced: true },
    })
  })

  it('passes each body to the matching action', async () => {
    for (const [name, body] of BODIES) {
      expect((await ok(`/api/campaigns/12/${name}`, body)).status).toBe(200)
    }
    expect(actionState.calls.map((c) => c.name)).toEqual(BODIES.map(([n]) => n))
    // /due formats: 10/30 becomes the end of that KST day.
    const deadline = actionState.calls.find((c) => c.name === 'deadline')?.params as {
      deadline: Date
    }
    expect(deadline.deadline.toISOString()).toBe('2026-10-30T14:59:00.000Z')
    // Memos and drafts are never written to the audit log, only their length.
    const audits = JSON.stringify(state.actions)
    expect(audits).not.toContain('일주일 써봄')
    expect(audits).not.toContain('내가 고친 글')
    expect(state.actions.find((a) => a.action === 'campaign.memo')?.detail).toMatchObject({
      chars: 6,
    })
  })

  it('reports an unsynced Telegram card without failing', async () => {
    actionState.next = { ok: true, telegramSynced: false }
    const res = await ok('/api/campaigns/12/apply', { revision: 2 })
    expect(res.status).toBe(200)
    expect((await res.json()).telegramSynced).toBe(false)
    expect(state.actions.at(-1)?.detail).toMatchObject({ telegramSynced: false })
  })

  it('409 with stale: true when the transition did not apply', async () => {
    actionState.next = {
      ok: false,
      reason: 'stale',
      message: '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요',
    }
    const res = await ok('/api/campaigns/12/apply', { revision: 2 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요',
      stale: true,
    })
    expect(state.actions.at(-1)).toMatchObject({ action: 'campaign.apply', result: 'stale' })
  })

  it('404 for an unknown campaign and for a malformed id', async () => {
    actionState.next = { ok: false, reason: 'not_found', message: 'not found' }
    expect((await ok('/api/campaigns/999/apply', { revision: 0 })).status).toBe(404)
    expect(state.actions.at(-1)).toMatchObject({ target: 'campaign:999', result: 'not_found' })
    expect((await ok('/api/campaigns/abc/apply', { revision: 0 })).status).toBe(404)
    expect(actionState.calls).toHaveLength(1)
  })

  it('400 for an invalid body, without running the action', async () => {
    const bad: [string, unknown][] = [
      ['apply', {}],
      ['apply', { revision: -1 }],
      ['apply', { revision: '2' }],
      ['reject', { revision: 2, reason: 'nope' }],
      ['result', { selected: 'yes' }],
      ['memo', { status: 'SELECTED', revision: 0, memo: 'x'.repeat(2001) }],
      ['deadline', { status: 'SELECTED', date: '' }],
      ['deadline', { status: 'SELECTED', date: '2026-02-30' }],
      ['deadline', { status: 'NOPE', date: '10/30' }],
    ]
    for (const [name, body] of bad) {
      const res = await ok(`/api/campaigns/12/${name}`, body)
      expect(res.status, `${name} ${JSON.stringify(body)}`).toBe(400)
    }
    expect((await ok('/api/campaigns/12/apply', '{not json')).status).toBe(400)
    expect(actionState.calls).toEqual([])
    expect(state.actions.every((a) => a.result === 'invalid')).toBe(true)
    expect(state.actions).toHaveLength(bad.length + 1)
  })

  it('400 with the action message when the action rejects the content', async () => {
    actionState.next = { ok: false, reason: 'invalid', message: '리뷰가 600자예요' }
    const res = await ok('/api/campaigns/12/draft', { revision: 3, text: 'x' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '리뷰가 600자예요' })
  })

  it('accepts a long Korean draft within the action body limit, refuses more', async () => {
    // 4000 Korean characters (the profile's largest review.maxChars) is 12KB of UTF-8.
    const text = '가'.repeat(4000)
    expect((await ok('/api/campaigns/12/draft', { revision: 3, text })).status).toBe(200)
    const tooLong = await ok('/api/campaigns/12/draft', { revision: 3, text: '가'.repeat(4001) })
    expect(tooLong.status).toBe(400)
    const huge = await ok('/api/campaigns/12/draft', { revision: 3, text: 'x'.repeat(17000) })
    expect(huge.status).toBe(400)
  })

  it('500 and an error audit row when the action throws', async () => {
    actionState.fail = new Error('db down')
    const res = await ok('/api/campaigns/12/apply', { revision: 2 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
    expect(state.actions.at(-1)).toMatchObject({ action: 'campaign.apply', result: 'error' })
  })
})

describe('ops run', () => {
  const auth_ = { ...SESSION_HEADERS, 'x-csrf-token': CSRF }
  const NAMES = [
    'threads-daily',
    'gift-collect',
    'musinsa-collect',
    'campaign-maintenance',
    'collect-insights',
  ]

  beforeEach(() => {
    opsRuns.length = 0
    opsQueued = true
  })

  it('needs same-origin JSON, a session and the CSRF token', async () => {
    const path = '/api/ops/gift-collect/run'
    const noOrigin = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth_ },
      body: '{}',
    })
    expect(noOrigin.status).toBe(403)
    expect((await post(path, {}, { ...auth_, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(path, {}, {})).status).toBe(401)
    expect((await post(path, {}, SESSION_HEADERS)).status).toBe(403)
    expect(
      (await post(path, {}, { ...SESSION_HEADERS, 'x-csrf-token': 'x'.repeat(43) })).status,
    ).toBe(403)
    expect(opsRuns).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('answers 405 to GET, 404 to unknown names', async () => {
    const get = await fetch(`${base}/api/ops/gift-collect/run`, { headers: SESSION_HEADERS })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await post('/api/ops/nope/run', {}, auth_)).status).toBe(404)
    expect((await post('/api/ops/constructor/run', {}, auth_)).status).toBe(404)
    expect(opsRuns).toEqual([])
  })

  it.each(NAMES)('%s: 202 queued and an audit row', async (name) => {
    const res = await post(`/api/ops/${name}/run`, {}, auth_)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, queued: true })
    expect(opsRuns).toEqual([name])
    expect(state.actions.at(-1)).toMatchObject({
      sessionId: 1,
      action: `ops.${name}`,
      result: 'ok',
      ip: '203.0.113.7',
      detail: { queued: true },
    })
  })

  it('200 queued:false when the job is busy or dropped', async () => {
    opsQueued = false
    const res = await post('/api/ops/threads-daily/run', {}, auth_)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, queued: false })
    expect(state.actions.at(-1)).toMatchObject({ detail: { queued: false } })
  })

  it('400 for a non-object body, without running anything', async () => {
    for (const body of ['[]', '"x"', 'null', '{bad']) {
      expect((await post('/api/ops/gift-collect/run', body, auth_)).status).toBe(400)
    }
    expect(opsRuns).toEqual([])
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.gift-collect', result: 'invalid' })
  })
})

describe('ops profile', () => {
  const auth_ = { ...SESSION_HEADERS, 'x-csrf-token': CSRF }
  const fields = {
    about: '  secret-about-text  ',
    interests: [' a ', 'a', ''],
    preferKeywords: [],
    excludeKeywords: [],
    excludeBrands: [],
    maxCompetition: null,
    minPriceWon: null,
    review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
    disclosure: null,
  }

  beforeEach(() => {
    profileCalls.length = 0
    profileStale = false
    profileThrows = false
  })

  it.each(['/api/ops/profile', '/api/ops/profile/reset'])(
    '%s needs same-origin JSON, a session and the CSRF token',
    async (path) => {
      const body = { revision: 0, profile: fields }
      const noOrigin = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth_ },
        body: JSON.stringify(body),
      })
      expect(noOrigin.status).toBe(403)
      expect((await post(path, body, {})).status).toBe(401)
      expect((await post(path, body, SESSION_HEADERS)).status).toBe(403)
      expect(profileCalls).toEqual([])
      expect(state.actions).toEqual([])
    },
  )

  it('405 for GET', async () => {
    for (const path of ['/api/ops/profile', '/api/ops/profile/reset']) {
      const get = await fetch(`${base}${path}`, { headers: SESSION_HEADERS })
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
    }
  })

  it('save: 200 with the normalized profile and an audit row without profile text', async () => {
    const res = await post('/api/ops/profile', { revision: 3, profile: fields }, auth_)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(profileResponse)
    expect(profileCalls).toEqual(['save:3:secret-about-text'])
    const row = state.actions.at(-1)
    expect(row).toMatchObject({ action: 'ops.profile', result: 'ok', detail: { revision: 3 } })
    expect(JSON.stringify(row)).not.toContain('secret-about-text')
  })

  it('save: a profile at its list limits fits the request size limit', async () => {
    // Five lists of 50 distinct 50-char Korean items: about 40KB of JSON, over the 16KB action limit.
    const list = (tag: string) =>
      Array.from({ length: 50 }, (_, i) => `${tag}${i}`.padEnd(50, '가'))
    const big = {
      ...fields,
      interests: list('a'),
      preferKeywords: list('b'),
      excludeKeywords: list('c'),
      excludeBrands: list('d'),
      review: { ...fields.review, points: list('e') },
    }
    expect(JSON.stringify(big).length).toBeGreaterThan(12000)
    const res = await post('/api/ops/profile', { revision: 3, profile: big }, auth_)
    expect(res.status).toBe(200)
    expect(profileCalls).toEqual(['save:3:secret-about-text'])
  })

  it('save: 400 with dotted field paths, nothing saved', async () => {
    const bad = {
      ...fields,
      interests: ['x', 'y', 'z', 'w'.repeat(51)],
      review: { ...fields.review, minChars: 600 },
    }
    const res = await post('/api/ops/profile', { revision: 0, profile: bad }, auth_)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('입력값을 확인해 주세요')
    expect(body.fields).toEqual(expect.arrayContaining(['interests.3', 'review.minChars']))
    expect(profileCalls).toEqual([])
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.profile', result: 'invalid' })
  })

  it.each([
    [{ profile: fields }],
    [{ revision: -1, profile: fields }],
    [{ revision: 1.5, profile: fields }],
    [{ revision: '1', profile: fields }],
    ['[]'],
    ['{bad'],
  ])('400 for a bad request %j', async (body) => {
    for (const path of ['/api/ops/profile', '/api/ops/profile/reset']) {
      expect((await post(path, body, auth_)).status).toBe(400)
    }
    expect(profileCalls).toEqual([])
  })

  it('save: 400 when the profile is missing', async () => {
    const res = await post('/api/ops/profile', { revision: 0 }, auth_)
    expect(res.status).toBe(400)
    expect(profileCalls).toEqual([])
  })

  it('409 stale for save and reset', async () => {
    profileStale = true
    const save = await post('/api/ops/profile', { revision: 2, profile: fields }, auth_)
    expect(save.status).toBe(409)
    expect(await save.json()).toEqual({
      error: '다른 곳에서 먼저 바뀌었어요. 새로 불러올게요',
      stale: true,
    })
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.profile', result: 'stale' })
    const reset = await post('/api/ops/profile/reset', { revision: 2 }, auth_)
    expect(reset.status).toBe(409)
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.profile.reset',
      result: 'stale',
      detail: { revision: 2 },
    })
  })

  it('reset: 200 and audit', async () => {
    const res = await post('/api/ops/profile/reset', { revision: 4 }, auth_)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(profileResponse)
    expect(profileCalls).toEqual(['reset:4'])
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.profile.reset',
      result: 'ok',
      detail: { revision: 4 },
    })
  })

  it('500 and an error audit row when the store throws', async () => {
    profileThrows = true
    const res = await post('/api/ops/profile', { revision: 1, profile: fields }, auth_)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('db down')
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.profile', result: 'error' })
  })
})

describe('ops schedule', () => {
  const auth_ = { ...SESSION_HEADERS, 'x-csrf-token': CSRF }
  const daily = (hours: number[]) => ({ minute: 0, hours })
  const fields = {
    threadsCollect: daily([6]),
    giftCollect: daily([15, 9, 9]),
    musinsaCollect: daily([10]),
    dailyPostCount: 3,
    publishSlots: ['8:00', '12:30'],
    campaignDailyMax: 5,
  }
  const paths = ['/api/ops/schedule', '/api/ops/schedule/reset']

  beforeEach(() => {
    scheduleCalls.length = 0
    scheduleStale = false
    scheduleThrows = false
    scheduleApplied = true
  })

  it.each(paths)('%s needs same-origin JSON, a session and the CSRF token', async (path) => {
    const body = { revision: 0, schedule: fields }
    const noOrigin = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth_ },
      body: JSON.stringify(body),
    })
    expect(noOrigin.status).toBe(403)
    expect((await post(path, body, {})).status).toBe(401)
    expect((await post(path, body, SESSION_HEADERS)).status).toBe(403)
    expect(scheduleCalls).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('405 for GET', async () => {
    for (const path of paths) {
      const get = await fetch(`${base}${path}`, { headers: SESSION_HEADERS })
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
    }
  })

  it('save: 200 with the normalized schedule passed on and an audit row with applied', async () => {
    const res = await post('/api/ops/schedule', { revision: 3, schedule: fields }, auth_)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(scheduleResponse())
    expect(scheduleCalls).toEqual(['save:3:9,15'])
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.schedule',
      result: 'ok',
      detail: { revision: 3, applied: true },
    })
  })

  it('applied false still answers 200 and is audited', async () => {
    scheduleApplied = false
    const res = await post('/api/ops/schedule/reset', { revision: 3 }, auth_)
    expect(res.status).toBe(200)
    expect((await res.json()).applied).toBe(false)
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.schedule.reset',
      result: 'ok',
      detail: { revision: 3, applied: false },
    })
  })

  it('save: 400 with dotted paths and nothing saved', async () => {
    const bad = { ...fields, giftCollect: daily([]), publishSlots: ['08:00', 'x', '25:00'] }
    const res = await post('/api/ops/schedule', { revision: 1, schedule: bad }, auth_)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fields).toEqual(
      expect.arrayContaining(['giftCollect.hours', 'publishSlots.1', 'publishSlots.2']),
    )
    expect(scheduleCalls).toEqual([])
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.schedule',
      result: 'invalid',
      detail: { revision: 1 },
    })
  })

  it.each([
    [{ schedule: fields }],
    [{ revision: -1, schedule: fields }],
    [{ revision: 1.5, schedule: fields }],
    [{ revision: '1', schedule: fields }],
  ])('400 for a bad revision %j', async (body) => {
    for (const path of paths) {
      expect((await post(path, body, auth_)).status).toBe(400)
    }
    expect(scheduleCalls).toEqual([])
  })

  it('save: 400 when the schedule is missing', async () => {
    const res = await post('/api/ops/schedule', { revision: 0 }, auth_)
    expect(res.status).toBe(400)
    expect(scheduleCalls).toEqual([])
  })

  it('409 stale on save and reset', async () => {
    scheduleStale = true
    const save = await post('/api/ops/schedule', { revision: 2, schedule: fields }, auth_)
    expect(save.status).toBe(409)
    expect(await save.json()).toMatchObject({ stale: true, error: expect.any(String) })
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.schedule', result: 'stale' })
    const reset = await post('/api/ops/schedule/reset', { revision: 2 }, auth_)
    expect(reset.status).toBe(409)
    expect(state.actions.at(-1)).toMatchObject({
      action: 'ops.schedule.reset',
      result: 'stale',
    })
  })

  it('reset: 200', async () => {
    const res = await post('/api/ops/schedule/reset', { revision: 4 }, auth_)
    expect(res.status).toBe(200)
    expect(scheduleCalls).toEqual(['reset:4'])
  })

  it('500 and an error audit row when the store throws', async () => {
    scheduleThrows = true
    const res = await post('/api/ops/schedule', { revision: 1, schedule: fields }, auth_)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('db down')
    expect(state.actions.at(-1)).toMatchObject({ action: 'ops.schedule', result: 'error' })
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
