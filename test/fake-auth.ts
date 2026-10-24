import type { AdminAction, CodeRequestResult, LoginResult } from '../src/web/auth.ts'
import { csrfFor, SESSION_COOKIE } from '../src/web/auth.ts'
import type { AdminAuth } from '../src/web/server.ts'

/** A session token that the fake auth accepts (same shape as a real one). */
export const TOKEN = 'a'.repeat(43)
export const SESSION_HEADERS = { Cookie: `${SESSION_COOKIE}=${TOKEN}` }
export const CSRF = csrfFor(TOKEN)

/**
 * In-memory AdminAuth for server tests: TOKEN is a live session, `nextCode` / `nextLogin` script
 * the next results, and every call is recorded.
 */
export function fakeAuth() {
  const state = {
    nextCode: { ok: true, code: '123456', expiresAt: new Date('2026-10-18T03:05:00Z') } as
      | CodeRequestResult
      | undefined,
    nextLogin: undefined as LoginResult | undefined,
    revokedAll: 0,
    revoked: [] as number[],
    expired: 0,
    actions: [] as AdminAction[],
    logins: [] as { code: string; ip: string | null; userAgent: string | null }[],
    live: new Set([TOKEN]),
  }
  const auth: AdminAuth = {
    requestCode: async () => {
      if (!state.nextCode) throw new Error('no scripted code result')
      return state.nextCode
    },
    expireCodes: async () => {
      state.expired++
    },
    login: async (code, client) => {
      state.logins.push({ code, ...client })
      if (!state.nextLogin) throw new Error('no scripted login result')
      return state.nextLogin
    },
    loadSession: async (token) =>
      state.live.has(token) ? { id: 1, expiresAt: new Date('2026-11-17T03:00:00Z') } : null,
    revokeSession: async (id) => {
      state.revoked.push(id)
    },
    revokeAll: async () => {
      state.revokedAll++
      return 2
    },
    record: async (a) => {
      state.actions.push(a)
    },
  }
  return { auth, state }
}
