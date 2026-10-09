import { describe, expect, it, vi } from 'vitest'
import { pingHealthcheck } from '../src/lib/healthcheck.ts'

const ok = (_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 200 }))

describe('pingHealthcheck', () => {
  it('does nothing when the URL is unset', async () => {
    const fetchImpl = vi.fn(ok)
    await pingHealthcheck(undefined, 'success', fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('GETs the URL on success', async () => {
    const fetchImpl = vi.fn(ok)
    await pingHealthcheck('https://hc-ping.com/abc', 'success', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://hc-ping.com/abc')
  })

  it('defaults to a success ping', async () => {
    const fetchImpl = vi.fn(ok)
    await pingHealthcheck('https://hc-ping.com/abc', undefined, fetchImpl)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://hc-ping.com/abc')
  })

  it('appends /fail for failures, tolerating a trailing slash', async () => {
    const fetchImpl = vi.fn(ok)
    await pingHealthcheck('https://hc-ping.com/abc/', 'fail', fetchImpl)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://hc-ping.com/abc/fail')
  })

  it('passes an abort signal so a hung server cannot block the caller', async () => {
    const fetchImpl = vi.fn(ok)
    await pingHealthcheck('https://hc-ping.com/abc', 'success', fetchImpl)
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('swallows network errors and non-2xx responses with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      pingHealthcheck('https://hc-ping.com/abc', 'success', () =>
        Promise.reject(new Error('boom')),
      ),
    ).resolves.toBeUndefined()
    await expect(
      pingHealthcheck('https://hc-ping.com/abc', 'success', () =>
        Promise.resolve(new Response(null, { status: 500 })),
      ),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
