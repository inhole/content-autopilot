import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { DryRunThreadsClient, type ThreadsApi, ThreadsClient } from './client.ts'

// Refresh when the token has less than this left. Tokens last 60 days.
const REFRESH_WITHIN_DAYS = 14
const SEEDED_TOKEN_DAYS = 59

type Account = { user_id: string; access_token: string; expires_at: Date | null }

/** Loads the stored account, seeding it from env on first use. */
async function loadAccount(): Promise<Account | null> {
  const [row] = await query<Account>(
    "select user_id, access_token, expires_at from platform_accounts where platform = 'THREADS'",
  )
  if (row) return row
  if (!config.THREADS_USER_ID || !config.THREADS_ACCESS_TOKEN) return null
  // A pasted long-lived token was just issued, so assume ~60 days (59 to be safe). Leaving the
  // expiry unknown made the next 04:00 job try to refresh a token younger than 24h, which Threads
  // rejects, raising a false "refresh failed" alert on day one.
  const [seeded] = await query<Account>(
    `insert into platform_accounts (platform, user_id, access_token, expires_at)
     values ('THREADS', $1, $2, now() + make_interval(days => $3))
     on conflict (platform) do nothing
     returning user_id, access_token, expires_at`,
    [config.THREADS_USER_ID, config.THREADS_ACCESS_TOKEN, SEEDED_TOKEN_DAYS],
  )
  return (
    seeded ?? {
      user_id: config.THREADS_USER_ID,
      access_token: config.THREADS_ACCESS_TOKEN,
      expires_at: null,
    }
  )
}

export async function getThreadsApi(): Promise<ThreadsApi> {
  if (config.THREADS_DRY_RUN) return new DryRunThreadsClient()
  const account = await loadAccount()
  if (!account) {
    throw new Error(
      'Threads account is not configured: set THREADS_USER_ID and THREADS_ACCESS_TOKEN',
    )
  }
  return new ThreadsClient({
    baseUrl: config.THREADS_API_BASE,
    userId: account.user_id,
    accessToken: account.access_token,
  })
}

export async function refreshThreadsTokenIfNeeded(): Promise<'refreshed' | 'fresh' | 'skipped'> {
  if (config.THREADS_DRY_RUN) return 'skipped'
  const account = await loadAccount()
  if (!account) return 'skipped'
  const msLeft = account.expires_at ? account.expires_at.getTime() - Date.now() : 0
  if (account.expires_at && msLeft > REFRESH_WITHIN_DAYS * 86_400_000) return 'fresh'

  const api = await getThreadsApi()
  const { accessToken, expiresInSeconds } = await api.refreshToken()
  await query(
    `update platform_accounts
     set access_token = $1, expires_at = now() + make_interval(secs => $2),
         refreshed_at = now(), updated_at = now()
     where platform = 'THREADS'`,
    [accessToken, expiresInSeconds],
  )
  return 'refreshed'
}

export async function threadsTokenExpiry(): Promise<Date | null> {
  const [row] = await query<{ expires_at: Date | null }>(
    "select expires_at from platform_accounts where platform = 'THREADS'",
  )
  return row?.expires_at ?? null
}
