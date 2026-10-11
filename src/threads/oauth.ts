import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

// One-time setup helpers for issuing the long-lived token (docs/setup.md 4-3).
// The redirect URI only has to match the app settings; the browser shows an error page and the
// owner copies the `code` from the address bar.
export const REDIRECT_URI = 'https://localhost/'
const SCOPES =
  'threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies,threads_manage_replies'

export function authorizeUrl(appId: string): string {
  const url = new URL('https://threads.com/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code',
  }).toString()
  return url.toString()
}

/** Accepts the bare code or the whole redirected URL, and drops the `#_` Threads appends. */
export function cleanCode(input: string): string {
  const trimmed = input.trim()
  const fromUrl = trimmed.startsWith('http') ? new URL(trimmed).searchParams.get('code') : null
  return (fromUrl ?? trimmed).replace(/#_?$/, '')
}

const shortToken = z.object({
  access_token: z.string(),
  user_id: z.union([z.string(), z.number()]),
})
const longToken = z.object({ access_token: z.string(), expires_in: z.number() })

async function json(res: Response, step: string): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) throw new Error(`${step} failed (${res.status}): ${text.slice(0, 300)}`)
  // Threads user ids exceed 2^53; read user_id from the raw text so a numeric JSON value is not
  // rounded by JSON.parse.
  const rawUserId = text.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1]
  const parsed = JSON.parse(text) as Record<string, unknown>
  return rawUserId ? { ...parsed, user_id: rawUserId } : parsed
}

/** Exchanges an authorization code for a long-lived (~60 day) token. */
export async function exchangeCode(opts: {
  appId: string
  appSecret: string
  code: string
  fetchFn?: typeof fetch
}): Promise<{ userId: string; accessToken: string; expiresInSeconds: number }> {
  const f = opts.fetchFn ?? fetch
  const short = shortToken.parse(
    await json(
      await f('https://graph.threads.com/oauth/access_token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: opts.appId,
          client_secret: opts.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
          code: opts.code,
        }),
        signal: AbortSignal.timeout(30_000),
      }),
      'code exchange',
    ),
  )
  const longUrl = new URL('https://graph.threads.net/access_token')
  longUrl.search = new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: opts.appSecret,
    access_token: short.access_token,
  }).toString()
  const long = longToken.parse(
    await json(await f(longUrl, { signal: AbortSignal.timeout(30_000) }), 'long-lived exchange'),
  )
  return {
    userId: String(short.user_id),
    accessToken: long.access_token,
    expiresInSeconds: long.expires_in,
  }
}

const meResponse = z.object({ id: z.string(), username: z.string() })

/**
 * Looks up the account behind a token. The dashboard's user token generator hands out a
 * long-lived token without the user id, which publishing needs.
 */
export async function lookupTokenOwner(
  accessToken: string,
  opts: { baseUrl?: string; fetchFn?: typeof fetch } = {},
): Promise<{ id: string; username: string }> {
  const url = new URL(`${opts.baseUrl ?? 'https://graph.threads.net'}/v1.0/me`)
  url.search = new URLSearchParams({ fields: 'id,username', access_token: accessToken }).toString()
  const res = await (opts.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(30_000) })
  return meResponse.parse(await json(res, 'token lookup'))
}

/** Sets KEY=value lines in a dotenv text, replacing existing (also empty or commented) entries. */
export function upsertEnv(text: string, values: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm')
    out = re.test(out) ? out.replace(re, line) : `${out.replace(/\n?$/, '\n')}${line}\n`
  }
  return out
}

export async function writeEnv(path: string, values: Record<string, string>): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => '')
  await writeFile(path, upsertEnv(text, values))
}
