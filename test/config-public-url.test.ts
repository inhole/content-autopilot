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
