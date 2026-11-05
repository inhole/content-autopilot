import { describe, expect, it } from 'vitest'
import { schema, threadChainMode } from '../src/config.ts'
import { chainFor } from '../src/pipeline/generate.ts'

const parse = (env: Record<string, string>) =>
  schema.safeParse({ ...process.env, THREAD_CHAIN_MODE: undefined, ...env } as Record<
    string,
    unknown
  >)

describe('threadChainMode', () => {
  it('follows THREAD_CHAIN_ENABLED when unset: true is the format experiment', () => {
    const on = parse({ THREAD_CHAIN_ENABLED: 'true' })
    const off = parse({ THREAD_CHAIN_ENABLED: 'false' })
    expect(on.success && threadChainMode(on.data)).toBe('alternate')
    expect(off.success && threadChainMode(off.data)).toBe('off')
  })

  it('prefers an explicit THREAD_CHAIN_MODE', () => {
    const r = parse({ THREAD_CHAIN_ENABLED: 'true', THREAD_CHAIN_MODE: 'on' })
    expect(r.success && threadChainMode(r.data)).toBe('on')
  })

  it('rejects an unknown mode at startup', () => {
    expect(parse({ THREAD_CHAIN_MODE: 'sometimes' }).success).toBe(false)
  })
})

describe('chainFor', () => {
  it('alternates by topic id parity, so a topic keeps its format', () => {
    expect([10, 11, 12, 13].map((id) => chainFor(id, 'alternate'))).toEqual([
      true,
      false,
      true,
      false,
    ])
  })

  it('is always on or always off outside the experiment', () => {
    expect([10, 11].map((id) => chainFor(id, 'on'))).toEqual([true, true])
    expect([10, 11].map((id) => chainFor(id, 'off'))).toEqual([false, false])
  })
})
