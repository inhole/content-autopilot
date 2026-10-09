import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyStatus, fetchArticle, TransientFetchError } from '../src/pipeline/article.ts'

const html = (body: string) =>
  new Response(
    `<html><head><title>T</title></head><body><article>${body}</article></body></html>`,
    {
      status: 200,
      headers: { 'content-type': 'text/html' },
    },
  )

afterEach(() => vi.unstubAllGlobals())

describe('classifyStatus', () => {
  it('separates retryable from permanent statuses', () => {
    expect(classifyStatus(200)).toBe('ok')
    for (const s of [408, 429, 500, 502, 503]) expect(classifyStatus(s)).toBe('transient')
    for (const s of [401, 403, 404, 410]) expect(classifyStatus(s)).toBe('permanent')
  })
})

describe('fetchArticle', () => {
  it('throws a transient error on 429 and 5xx', async () => {
    for (const status of [429, 503]) {
      vi.stubGlobal('fetch', async () => new Response('', { status }))
      await expect(fetchArticle('https://x.test')).rejects.toBeInstanceOf(TransientFetchError)
    }
  })

  it('throws a transient error on network failures and timeouts', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(fetchArticle('https://x.test')).rejects.toBeInstanceOf(TransientFetchError)
  })

  it('returns null for permanent outcomes', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    expect(await fetchArticle('https://x.test')).toBeNull()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    )
    expect(await fetchArticle('https://x.test')).toBeNull()
    vi.stubGlobal('fetch', async () => html('<p>short</p>'))
    expect(await fetchArticle('https://x.test')).toBeNull()
  })

  it('extracts long article text', async () => {
    const para = `<p>${'Readable sentence about AI news. '.repeat(30)}</p>`
    vi.stubGlobal('fetch', async () => html(para))
    const article = await fetchArticle('https://x.test')
    expect(article?.text.length).toBeGreaterThan(200)
  })
})
