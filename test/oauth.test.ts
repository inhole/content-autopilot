import { describe, expect, it, vi } from 'vitest'
import {
  authorizeUrl,
  cleanCode,
  exchangeCode,
  lookupTokenOwner,
  upsertEnv,
} from '../src/threads/oauth.ts'

describe('threads oauth helpers', () => {
  it('builds the authorize URL', () => {
    const url = new URL(authorizeUrl('123'))
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost/')
    expect(url.searchParams.get('scope')).toContain('threads_content_publish')
  })

  it('cleans a pasted code or redirect URL', () => {
    expect(cleanCode('AQBx#_')).toBe('AQBx')
    expect(cleanCode('  AQBx ')).toBe('AQBx')
    expect(cleanCode('https://localhost/?code=AQBx#_')).toBe('AQBx')
  })

  it('exchanges a code for a long-lived token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short', user_id: 42 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'long', expires_in: 5_184_000 })),
      )
    const out = await exchangeCode({ appId: 'a', appSecret: 's', code: 'c', fetchFn })
    expect(out).toEqual({ userId: '42', accessToken: 'long', expiresInSeconds: 5_184_000 })
    const longUrl = new URL(String(fetchFn.mock.calls[1]?.[0]))
    expect(longUrl.searchParams.get('access_token')).toBe('short')
  })

  it('keeps a user_id beyond 2^53 exact', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"access_token":"short","user_id":17841400123456789}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'l', expires_in: 1 })))
    const out = await exchangeCode({ appId: 'a', appSecret: 's', code: 'c', fetchFn })
    expect(out.userId).toBe('17841400123456789')
  })

  it('surfaces the API error body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Invalid code"}}', { status: 400 }))
    await expect(exchangeCode({ appId: 'a', appSecret: 's', code: 'c', fetchFn })).rejects.toThrow(
      'Invalid code',
    )
  })

  it('upserts env lines without touching others', () => {
    const before = 'DATABASE_URL=x\nTHREADS_USER_ID=\n# THREADS_ACCESS_TOKEN=old\n'
    expect(upsertEnv(before, { THREADS_USER_ID: '1', THREADS_ACCESS_TOKEN: 't' })).toBe(
      'DATABASE_URL=x\nTHREADS_USER_ID=1\nTHREADS_ACCESS_TOKEN=t\n',
    )
    expect(upsertEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n')
  })
})

describe('lookupTokenOwner', () => {
  it('reads id and username from /me, keeping a long id exact', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"id":"17841400123456789","username":"devbrief.kr"}'))
    const out = await lookupTokenOwner('tok', { fetchFn })
    expect(out).toEqual({ id: '17841400123456789', username: 'devbrief.kr' })
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/v1.0/me')
    expect(url.searchParams.get('fields')).toBe('id,username')
  })
})
