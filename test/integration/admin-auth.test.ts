import { beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../src/db/pool.ts'
import {
  CODE_MAX_ATTEMPTS,
  CODE_REQUESTS_PER_HOUR,
  csrfFor,
  loadSession,
  loginWithCode,
  recordAdminAction,
  requestLoginCode,
  revokeAllSessions,
  revokeSession,
} from '../../src/web/auth.ts'

const client = { ip: '203.0.113.7', userAgent: 'vitest' }

beforeEach(async () => {
  await pool.query('truncate admin_actions, admin_sessions, admin_login_codes restart identity')
})

/** Moves every code's creation time back, so the 1-per-minute limit does not apply. */
const ageCodes = (seconds: number) =>
  query(
    `update admin_login_codes set created_at = created_at - make_interval(secs => $1),
       expires_at = expires_at - make_interval(secs => $1) + interval '5 minutes'`,
    [seconds],
  )

async function issue(): Promise<string> {
  const r = await requestLoginCode('203.0.113.7')
  if (!r.ok) throw new Error(`code refused: ${r.reason}`)
  return r.code
}

const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000')

describe('login codes', () => {
  it('stores only a hash of a 6-digit code that expires in 5 minutes', async () => {
    const r = await requestLoginCode('203.0.113.7')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toMatch(/^\d{6}$/)
    const [row] = await query<{ code_hash: string; ttl: number; ip: string }>(
      `select code_hash, extract(epoch from expires_at - created_at)::int as ttl, ip
       from admin_login_codes`,
    )
    expect(row?.code_hash).not.toContain(r.code)
    expect(row?.code_hash).toHaveLength(64)
    expect(row?.ttl).toBe(300)
    expect(row?.ip).toBe('203.0.113.7')
  })

  it('allows one request per minute and five per hour', async () => {
    await issue()
    const soon = await requestLoginCode(null)
    expect(soon).toMatchObject({ ok: false, reason: 'too_soon' })
    if (!soon.ok) expect(soon.retryAfterS).toBeGreaterThan(50)

    for (let i = 1; i < CODE_REQUESTS_PER_HOUR; i++) {
      await ageCodes(61)
      await issue()
    }
    await ageCodes(61)
    const limited = await requestLoginCode(null)
    expect(limited).toMatchObject({ ok: false, reason: 'hourly_limit', firstLimitHit: true })
    await recordAdminAction({
      sessionId: null,
      action: 'code_request',
      result: 'hourly_limit',
      ip: null,
    })
    expect(await requestLoginCode(null)).toMatchObject({ firstLimitHit: false })

    // Requests older than an hour no longer count.
    await ageCodes(3600)
    expect((await requestLoginCode(null)).ok).toBe(true)
  })

  it('a new code replaces the previous one', async () => {
    const first = await issue()
    await ageCodes(61)
    const second = await issue()
    if (first !== second) {
      expect(await loginWithCode(first, client)).toMatchObject({ ok: false })
    }
    expect((await loginWithCode(second, client)).ok).toBe(true)
  })
})

describe('login', () => {
  it('opens a 30-day session for the right code, once', async () => {
    const code = await issue()
    const r = await loginWithCode(code, client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.session.csrf).toBe(csrfFor(r.session.token))
    const days = (r.session.expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)

    const [s] = await query<{ token_hash: string; ip: string; user_agent: string }>(
      'select token_hash, ip, user_agent from admin_sessions',
    )
    expect(s?.token_hash).not.toBe(r.session.token)
    expect(s).toMatchObject({ ip: '203.0.113.7', user_agent: 'vitest' })
    expect(await loadSession(r.session.token)).toMatchObject({ id: r.session.id })

    // The code is used up.
    expect(await loginWithCode(code, client)).toEqual({ ok: false, reason: 'no_code' })
  })

  it('locks the code after five wrong attempts, even for the right code', async () => {
    const code = await issue()
    for (let left = CODE_MAX_ATTEMPTS - 1; left > 0; left--) {
      expect(await loginWithCode(wrongFor(code), client)).toEqual({
        ok: false,
        reason: 'wrong',
        attemptsLeft: left,
      })
    }
    expect(await loginWithCode(wrongFor(code), client)).toEqual({ ok: false, reason: 'locked' })
    expect(await loginWithCode(code, client)).toEqual({ ok: false, reason: 'locked' })
    expect(await query('select 1 from admin_sessions')).toHaveLength(0)
  })

  it('rejects an expired code', async () => {
    const code = await issue()
    await query("update admin_login_codes set expires_at = now() - interval '1 second'")
    expect(await loginWithCode(code, client)).toEqual({ ok: false, reason: 'no_code' })
  })

  it('serializes parallel logins: one code opens one session', async () => {
    const code = await issue()
    const results = await Promise.all([1, 2, 3].map(() => loginWithCode(code, client)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await query('select 1 from admin_sessions')).toHaveLength(1)
  })
})

describe('sessions', () => {
  async function login(): Promise<{ id: number; token: string }> {
    await ageCodes(61)
    const r = await loginWithCode(await issue(), client)
    if (!r.ok) throw new Error('login failed')
    return r.session
  }

  it('unknown, expired and revoked sessions do not load', async () => {
    expect(await loadSession('x'.repeat(43))).toBeNull()
    const a = await login()
    const b = await login()
    await query(
      `update admin_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [a.id],
    )
    expect(await loadSession(a.token)).toBeNull()
    await revokeSession(b.id)
    expect(await loadSession(b.token)).toBeNull()
  })

  it('revokeAllSessions ends every live session', async () => {
    const a = await login()
    const b = await login()
    expect(await revokeAllSessions()).toBe(2)
    expect(await loadSession(a.token)).toBeNull()
    expect(await loadSession(b.token)).toBeNull()
    expect(await revokeAllSessions()).toBe(0)
  })

  it('refreshes last_seen_at at most every few minutes', async () => {
    const a = await login()
    await query(`update admin_sessions set last_seen_at = now() - interval '1 hour'`)
    await loadSession(a.token)
    const [row] = await query<{ recent: boolean }>(
      `select last_seen_at > now() - interval '1 minute' as recent from admin_sessions`,
    )
    expect(row?.recent).toBe(true)
  })
})

describe('audit log', () => {
  it('records actions with their session', async () => {
    await recordAdminAction({
      sessionId: null,
      action: 'login',
      result: 'wrong',
      ip: '203.0.113.7',
      detail: { note: 1 },
    })
    const rows = await query<{ action: string; result: string; detail: unknown }>(
      'select action, result, detail from admin_actions',
    )
    expect(rows).toEqual([{ action: 'login', result: 'wrong', detail: { note: 1 } }])
  })
})
