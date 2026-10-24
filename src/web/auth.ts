import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { type Query, query, transaction } from '../db/pool.ts'

// Admin console login (docs/dashboard.md): a one-time code goes to the owner's Telegram chat, the
// code buys a server-side session, and the browser holds only a random token in an HttpOnly cookie.
// Codes and tokens are stored as sha256 hashes. One owner, so the limits are global, not per user.

export const SESSION_COOKIE = 'ca_session'
export const CODE_TTL_MINUTES = 5
export const CODE_MAX_ATTEMPTS = 5
export const SESSION_TTL_DAYS = 30
/** Seconds between two code requests, and requests allowed per hour. */
export const CODE_REQUEST_INTERVAL_S = 60
export const CODE_REQUESTS_PER_HOUR = 5
// last_seen_at is a convenience for the owner, not worth a write on every request.
const SEEN_UPDATE_MINUTES = 5

// Serializes code requests and checks so two parallel requests cannot both pass a limit.
const LOCK_KEY = 'admin_login_code'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Constant-time comparison of two hex digests. */
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The CSRF token of a session, derived from its cookie token so nothing extra is stored. */
export const csrfFor = (token: string) =>
  createHash('sha256').update(`csrf:${token}`).digest('base64url')

export function csrfMatches(token: string, given: string | undefined): boolean {
  if (!given) return false
  const expected = Buffer.from(csrfFor(token))
  const actual = Buffer.from(given)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export type CodeRequestResult =
  | { ok: true; code: string; expiresAt: Date }
  | {
      ok: false
      reason: 'too_soon' | 'hourly_limit'
      retryAfterS: number
      /** True for the first rejected request of the hour, so the owner is alerted only once. */
      firstLimitHit: boolean
    }

/** Issues a new code (older unused ones stop working) unless a request limit is hit. */
export async function requestLoginCode(ip: string | null): Promise<CodeRequestResult> {
  return transaction(async (q) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY])
    const [stats] = await q<{ last_s: number | null; hour_count: number; oldest_s: number | null }>(
      `select extract(epoch from now() - max(created_at))::float8 as last_s,
              count(*)::int as hour_count,
              extract(epoch from now() - min(created_at))::float8 as oldest_s
       from admin_login_codes where created_at > now() - interval '1 hour'`,
    )
    const lastS = stats?.last_s ?? null
    if (lastS !== null && lastS < CODE_REQUEST_INTERVAL_S) {
      return {
        ok: false,
        reason: 'too_soon',
        retryAfterS: Math.ceil(CODE_REQUEST_INTERVAL_S - lastS),
        firstLimitHit: false,
      }
    }
    if ((stats?.hour_count ?? 0) >= CODE_REQUESTS_PER_HOUR) {
      const [prev] = await q<{ n: number }>(
        `select count(*)::int as n from admin_actions
         where action = 'code_request' and result = 'hourly_limit' and at > now() - interval '1 hour'`,
      )
      return {
        ok: false,
        reason: 'hourly_limit',
        retryAfterS: Math.max(1, Math.ceil(3600 - (stats?.oldest_s ?? 0))),
        firstLimitHit: (prev?.n ?? 0) === 0,
      }
    }
    await q(
      `update admin_login_codes set expires_at = least(expires_at, now())
       where used_at is null and expires_at > now()`,
    )
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const [row] = await q<{ expires_at: Date }>(
      `insert into admin_login_codes (code_hash, expires_at, ip)
       values ($1, now() + make_interval(mins => $2), $3) returning expires_at`,
      [sha256(code), CODE_TTL_MINUTES, ip],
    )
    return { ok: true, code, expiresAt: (row as { expires_at: Date }).expires_at }
  })
}

/** Expires every unused code, e.g. when the Telegram message carrying it could not be sent. */
export async function expireLoginCodes(q: Query = query): Promise<void> {
  await q(
    'update admin_login_codes set expires_at = least(expires_at, now()) where used_at is null',
  )
}

export type NewSession = { id: number; token: string; csrf: string; expiresAt: Date }

export type LoginResult =
  | { ok: true; session: NewSession }
  | { ok: false; reason: 'no_code' | 'locked' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number }

/**
 * Checks a code against the newest live one. A match uses the code up and opens a session; a
 * miss counts an attempt, and the code stops working after CODE_MAX_ATTEMPTS misses.
 */
export async function loginWithCode(
  code: string,
  client: { ip: string | null; userAgent: string | null },
): Promise<LoginResult> {
  return transaction(async (q) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY])
    const [live] = await q<{ id: number; code_hash: string; attempts: number }>(
      `select id, code_hash, attempts from admin_login_codes
       where used_at is null and expires_at > now()
       order by id desc limit 1`,
    )
    if (!live) return { ok: false, reason: 'no_code' }
    if (live.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, reason: 'locked' }
    if (!sameHash(sha256(code), live.code_hash)) {
      const attempts = live.attempts + 1
      await q('update admin_login_codes set attempts = $2 where id = $1', [live.id, attempts])
      return attempts >= CODE_MAX_ATTEMPTS
        ? { ok: false, reason: 'locked' }
        : { ok: false, reason: 'wrong', attemptsLeft: CODE_MAX_ATTEMPTS - attempts }
    }
    await q('update admin_login_codes set used_at = now() where id = $1', [live.id])
    const token = randomBytes(32).toString('base64url')
    const [row] = await q<{ id: number; expires_at: Date }>(
      `insert into admin_sessions (token_hash, expires_at, ip, user_agent)
       values ($1, now() + make_interval(days => $2), $3, $4) returning id, expires_at`,
      [sha256(token), SESSION_TTL_DAYS, client.ip, client.userAgent?.slice(0, 300) ?? null],
    )
    const s = row as { id: number; expires_at: Date }
    return { ok: true, session: { id: s.id, token, csrf: csrfFor(token), expiresAt: s.expires_at } }
  })
}

export type ActiveSession = { id: number; expiresAt: Date }

/** The live session of a cookie token, or null when unknown, revoked or expired. */
export async function loadSession(token: string): Promise<ActiveSession | null> {
  const [row] = await query<{ id: number; expires_at: Date; stale: boolean }>(
    `select id, expires_at, last_seen_at < now() - make_interval(mins => $2) as stale
     from admin_sessions
     where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(token), SEEN_UPDATE_MINUTES],
  )
  if (!row) return null
  if (row.stale) {
    await query('update admin_sessions set last_seen_at = now() where id = $1', [row.id])
  }
  return { id: row.id, expiresAt: row.expires_at }
}

export async function revokeSession(id: number): Promise<void> {
  await query('update admin_sessions set revoked_at = now() where id = $1 and revoked_at is null', [
    id,
  ])
}

/** Revokes every live session and returns how many there were. */
export async function revokeAllSessions(): Promise<number> {
  const rows = await query(
    `update admin_sessions set revoked_at = now()
     where revoked_at is null and expires_at > now() returning id`,
  )
  return rows.length
}

export type AdminAction = {
  sessionId: number | null
  action: string
  target?: string | null
  result: string
  ip: string | null
  detail?: Record<string, unknown> | null
}

/** Appends one row to the audit log. */
export async function recordAdminAction(a: AdminAction): Promise<void> {
  await query(
    `insert into admin_actions (session_id, action, target, result, ip, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [a.sessionId, a.action, a.target ?? null, a.result, a.ip, a.detail ?? null],
  )
}
