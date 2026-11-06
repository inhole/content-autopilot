import { describe, expect, it } from 'vitest'
import { schema } from '../src/config.ts'

const parse = (PUBLIC_BASE_URL?: string) =>
  schema.safeParse({ ...process.env, PUBLIC_BASE_URL } as Record<string, unknown>)

describe('PUBLIC_BASE_URL', () => {
  it('is optional', () => {
    const r = parse(undefined)
    expect(r.success && r.data.PUBLIC_BASE_URL).toBeUndefined()
  })
  it('accepts an https origin and drops a trailing slash', () => {
    const r = parse('https://content-autopilot-production-8b81.up.railway.app/')
    expect(r.success && r.data.PUBLIC_BASE_URL).toBe(
      'https://content-autopilot-production-8b81.up.railway.app',
    )
  })
  it.each([
    'http://x.example',
    'x.example',
    'https://x.example/path',
    'https://x.example?a=1',
    'javascript:alert(1)',
  ])('rejects %s', (v) => {
    expect(parse(v).success).toBe(false)
  })
})

const parseEnv = (env: Record<string, string>) =>
  schema.safeParse({ ...process.env, ...env } as Record<string, unknown>)

describe('PUBLISH_SLOTS', () => {
  it('pads, drops empty entries, dedupes and sorts', () => {
    const r = parseEnv({ PUBLISH_SLOTS: '21:00, 8:00,21:00,' })
    expect(r.success && r.data.PUBLISH_SLOTS).toEqual(['08:00', '21:00'])
  })
  it.each(['', ',', '25:00', '8', '08:00,noon'])('rejects %j', (v) => {
    expect(parseEnv({ PUBLISH_SLOTS: v }).success).toBe(false)
  })
})

describe('video limits', () => {
  it('caps VIDEO_UPLOAD_MAX_MB at the Telegram bot file limit', () => {
    expect(parseEnv({ VIDEO_UPLOAD_MAX_MB: '50' }).success).toBe(true)
    expect(parseEnv({ VIDEO_UPLOAD_MAX_MB: '51' }).success).toBe(false)
  })
  it('dedupes VIDEO_PLATFORMS', () => {
    const r = parseEnv({ VIDEO_PLATFORMS: 'shorts, Shorts,reels' })
    expect(r.success && r.data.VIDEO_PLATFORMS).toEqual(['shorts', 'reels'])
  })
})
