import { createServer } from 'node:http'
import { z } from 'zod'
import { config, requireValue } from '../config.ts'
import { query } from '../db/pool.ts'
import { DryRunInstagram, type InstagramApi, InstagramClient } from './instagram.ts'
import type { Platform } from './types.ts'
import { DryRunYouTube, type YouTubeApi, YouTubeAuthError, YouTubeClient } from './youtube.ts'

// Instagram and YouTube accounts in platform_accounts (docs/plans/video.md 3-11). Like the Threads
// token, the DB copy is authoritative once seeded.

type Account = {
  user_id: string
  access_token: string
  refresh_token: string | null
  expires_at: Date | null
}

const REFRESH_WITHIN_DAYS = 14
const SEEDED_TOKEN_DAYS = 59
/** A YouTube access token is renewed when it has less than this left. */
const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000

async function loadAccount(platform: 'INSTAGRAM' | 'YOUTUBE'): Promise<Account | null> {
  const [row] = await query<Account>(
    `select user_id, access_token, refresh_token, expires_at from platform_accounts
     where platform = $1`,
    [platform],
  )
  return row ?? null
}

/** Loads the Instagram account, seeding it from env on first use (a fresh 60-day token). */
async function loadInstagramAccount(): Promise<Account | null> {
  const row = await loadAccount('INSTAGRAM')
  if (row) return row
  if (!config.INSTAGRAM_USER_ID || !config.INSTAGRAM_ACCESS_TOKEN) return null
  const [seeded] = await query<Account>(
    `insert into platform_accounts (platform, user_id, access_token, expires_at)
     values ('INSTAGRAM', $1, $2, now() + make_interval(days => $3))
     on conflict (platform) do nothing
     returning user_id, access_token, refresh_token, expires_at`,
    [config.INSTAGRAM_USER_ID, config.INSTAGRAM_ACCESS_TOKEN, SEEDED_TOKEN_DAYS],
  )
  return seeded ?? (await loadAccount('INSTAGRAM'))
}

export async function getInstagramApi(): Promise<InstagramApi> {
  if (config.VIDEO_PUBLISH_DRY_RUN) return new DryRunInstagram()
  const account = await loadInstagramAccount()
  if (!account) {
    throw new Error(
      'Instagram account is not configured: set INSTAGRAM_USER_ID and INSTAGRAM_ACCESS_TOKEN',
    )
  }
  return new InstagramClient({
    baseUrl: config.INSTAGRAM_API_BASE,
    userId: account.user_id,
    accessToken: account.access_token,
  })
}

export async function refreshInstagramTokenIfNeeded(): Promise<'refreshed' | 'fresh' | 'skipped'> {
  if (config.VIDEO_PUBLISH_DRY_RUN || !config.VIDEO_PLATFORMS.includes('reels')) return 'skipped'
  const account = await loadInstagramAccount()
  if (!account) return 'skipped'
  const msLeft = account.expires_at ? account.expires_at.getTime() - Date.now() : 0
  if (account.expires_at && msLeft > REFRESH_WITHIN_DAYS * 86_400_000) return 'fresh'
  const { accessToken, expiresInSeconds } = await (await getInstagramApi()).refreshToken()
  await query(
    `update platform_accounts set access_token = $1,
       expires_at = now() + make_interval(secs => $2), refreshed_at = now(), updated_at = now()
     where platform = 'INSTAGRAM'`,
    [accessToken, expiresInSeconds],
  )
  return 'refreshed'
}

export async function instagramTokenExpiry(): Promise<Date | null> {
  return (await loadAccount('INSTAGRAM'))?.expires_at ?? null
}

// YouTube OAuth (desktop client, loopback redirect)

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
})

export function youtubeAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    // offline + consent: Google returns a refresh token every time.
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()
  return url.toString()
}

async function tokenRequest(
  params: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<z.infer<typeof tokenResponse>> {
  const res = await fetchFn(GOOGLE_TOKEN, {
    method: 'POST',
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    if (text.includes('invalid_grant')) {
      throw new YouTubeAuthError(
        'YouTube 인증이 만료됐어요: npm run cli -- youtube:auth 로 다시 인증해 주세요',
      )
    }
    throw new Error(`Google token ${res.status}: ${text.slice(0, 300)}`)
  }
  return tokenResponse.parse(JSON.parse(text))
}

/** Stores the channel id with access token, expiry and refresh token in one statement. */
export async function saveYouTubeAccount(a: {
  channelId: string
  accessToken: string
  expiresInSeconds: number
  refreshToken: string
}): Promise<void> {
  await query(
    `insert into platform_accounts (platform, user_id, access_token, refresh_token, expires_at)
     values ('YOUTUBE', $1, $2, $3, now() + make_interval(secs => $4))
     on conflict (platform) do update set user_id = excluded.user_id,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, refreshed_at = now(), updated_at = now()`,
    [a.channelId, a.accessToken, a.refreshToken, a.expiresInSeconds],
  )
}

/** A valid access token, renewed with the refresh token when it is about to expire. */
async function youtubeAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
  const account = await loadAccount('YOUTUBE')
  if (!account?.refresh_token) {
    throw new YouTubeAuthError(
      'YouTube 계정이 없어요: npm run cli -- youtube:auth 를 먼저 실행해 주세요',
    )
  }
  if (account.expires_at && account.expires_at.getTime() - Date.now() > ACCESS_TOKEN_MARGIN_MS) {
    return account.access_token
  }
  const t = await tokenRequest(
    {
      client_id: requireValue('YOUTUBE_CLIENT_ID'),
      client_secret: requireValue('YOUTUBE_CLIENT_SECRET'),
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    },
    fetchFn,
  )
  // A refresh response usually has no refresh_token; keep the stored one then.
  await query(
    `update platform_accounts set access_token = $1,
       expires_at = now() + make_interval(secs => $2),
       refresh_token = coalesce($3, refresh_token), refreshed_at = now(), updated_at = now()
     where platform = 'YOUTUBE'`,
    [t.access_token, t.expires_in, t.refresh_token ?? null],
  )
  return t.access_token
}

export async function getYouTubeApi(): Promise<YouTubeApi> {
  if (config.VIDEO_PUBLISH_DRY_RUN) return new DryRunYouTube()
  return new YouTubeClient({ accessToken: () => youtubeAccessToken() })
}

/** The account id dry-run approvals are bound to. */
export const DRY_RUN_ACCOUNT = 'dry-run'

/**
 * The account a publication is bound to at approval time: the Instagram user id or the YouTube
 * channel id. Null when the account is not set up (approval then refuses).
 */
export async function currentAccountId(platform: Platform): Promise<string | null> {
  if (config.VIDEO_PUBLISH_DRY_RUN) return DRY_RUN_ACCOUNT
  if (platform === 'REELS') return (await loadInstagramAccount())?.user_id ?? null
  return (await loadAccount('YOUTUBE'))?.user_id ?? null
}

/**
 * One-time CLI flow: listens on 127.0.0.1 for Google's redirect, exchanges the code, looks up the
 * channel and stores everything. `log` prints the URL to open.
 */
export async function runYouTubeAuth(log: (line: string) => void): Promise<{ channel: string }> {
  const clientId = requireValue('YOUTUBE_CLIENT_ID')
  const clientSecret = requireValue('YOUTUBE_CLIENT_SECRET')
  const state = crypto.randomUUID()
  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        const got = url.searchParams.get('code')
        if (!got || url.searchParams.get('state') !== state) {
          res.writeHead(400).end('missing code or state')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('인증 완료. 이 창을 닫고 터미널로 돌아가세요.')
        server.close()
        resolve({ code: got, redirectUri })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('could not open a local port'))
          return
        }
        redirectUri = `http://127.0.0.1:${address.port}`
        log(
          `브라우저에서 이 주소를 열어 YouTube 채널 계정으로 로그인하세요:\n${youtubeAuthUrl(clientId, redirectUri, state)}`,
        )
      })
      setTimeout(() => {
        server.close()
        reject(new Error('timed out waiting for the Google redirect (5 min)'))
      }, 5 * 60_000).unref()
    },
  )
  const t = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (!t.refresh_token) throw new Error('Google returned no refresh token; run youtube:auth again')
  const channel = await new YouTubeClient({ accessToken: async () => t.access_token }).channel()
  await saveYouTubeAccount({
    channelId: channel.id,
    accessToken: t.access_token,
    expiresInSeconds: t.expires_in,
    refreshToken: t.refresh_token,
  })
  return { channel: `${channel.title} (${channel.id})` }
}
