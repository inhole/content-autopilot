import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.ts'
import { query } from '../../src/db/pool.ts'
import { refreshInstagramTokenIfNeeded, youtubeAccessToken } from '../../src/video/accounts.ts'

const DAY = 86_400_000

/** A fetch answering every call with `body`; records the URLs and bodies it got. */
function fakeFetch(body: unknown) {
  const calls: { url: string; body: string }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function withConfig<T>(patch: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...config }
  Object.assign(config, patch)
  try {
    return await fn()
  } finally {
    Object.assign(config, saved)
  }
}

const account = async (platform: string) => {
  const [row] = await query<{
    access_token: string
    refresh_token: string | null
    expires_at: Date
  }>('select access_token, refresh_token, expires_at from platform_accounts where platform = $1', [
    platform,
  ])
  return row
}

describe('YouTube access token', () => {
  const youtube = { YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'secret' }

  it('renews a token about to expire and keeps the refresh token Google did not resend', async () => {
    await query(
      `insert into platform_accounts (platform, user_id, access_token, refresh_token, expires_at)
       values ('YOUTUBE', 'ch', 'old', 'r1', now() + interval '1 minute')`,
    )
    const { impl, calls } = fakeFetch({ access_token: 'new', expires_in: 3600 })
    await withConfig(youtube, async () => {
      expect(await youtubeAccessToken(impl)).toBe('new')
      // Fresh now: no second request.
      expect(await youtubeAccessToken(impl)).toBe('new')
    })
    expect(calls).toHaveLength(1)
    expect(new URLSearchParams(calls[0]?.body).get('refresh_token')).toBe('r1')
    const row = await account('YOUTUBE')
    expect(row?.refresh_token).toBe('r1')
    expect((row?.expires_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(3500_000)

    await query("update platform_accounts set expires_at = now() where platform = 'YOUTUBE'")
    const rotated = fakeFetch({ access_token: 'newer', expires_in: 3600, refresh_token: 'r2' })
    await withConfig(youtube, () => youtubeAccessToken(rotated.impl))
    expect((await account('YOUTUBE'))?.refresh_token).toBe('r2')
  })
})

describe('Instagram token refresh', () => {
  const reels = { VIDEO_PUBLISH_DRY_RUN: false, VIDEO_PLATFORMS: ['reels'] } as Partial<
    typeof config
  >
  const seed = (msLeft: number) =>
    query(
      `insert into platform_accounts (platform, user_id, access_token, expires_at)
       values ('INSTAGRAM', 'u1', 'old', $1)`,
      [new Date(Date.now() + msLeft)],
    )

  it('leaves a token with more than 14 days left alone', async () => {
    await seed(14 * DAY + 3600_000)
    const { impl, calls } = fakeFetch({ access_token: 'new', expires_in: 60 * DAY })
    expect(await withConfig(reels, () => refreshInstagramTokenIfNeeded(impl))).toBe('fresh')
    expect(calls).toHaveLength(0)
    expect((await account('INSTAGRAM'))?.access_token).toBe('old')
  })

  it('refreshes a token within 14 days of expiry', async () => {
    await seed(14 * DAY - 3600_000)
    const { impl, calls } = fakeFetch({ access_token: 'new', expires_in: 60 * 86_400 })
    expect(await withConfig(reels, () => refreshInstagramTokenIfNeeded(impl))).toBe('refreshed')
    expect(calls[0]?.url).toContain('/refresh_access_token')
    const row = await account('INSTAGRAM')
    expect(row?.access_token).toBe('new')
    expect((row?.expires_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(59 * DAY)
  })
})
