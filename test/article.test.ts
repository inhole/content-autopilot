import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyStatus,
  fetchArticle,
  isBotChallenge,
  TransientFetchError,
} from '../src/pipeline/article.ts'

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

  it('treats a bot-check page as unreadable instead of extracting its notice', async () => {
    const notice = `<p>${'You are seeing this because the administrator set up Anubis. '.repeat(20)}</p>`
    const page = new Response(
      `<html><head><title>Making sure you&#39;re not a bot!</title></head><body>
        <script id="anubis_challenge" type="application/json">{}</script>
        <article>${notice}</article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    )
    vi.stubGlobal('fetch', async () => page)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await fetchArticle('https://lore.kernel.org/x')).toBeNull()
  })

  it('extracts long article text', async () => {
    const para = `<p>${'Readable sentence about AI news. '.repeat(30)}</p>`
    vi.stubGlobal('fetch', async () => html(para))
    const article = await fetchArticle('https://x.test')
    expect(article?.text.length).toBeGreaterThan(200)
  })
})

describe('isBotChallenge', () => {
  it('recognises Anubis and Cloudflare challenge pages', () => {
    expect(isBotChallenge('<script id="anubis_challenge"></script>')).toBe(true)
    expect(isBotChallenge('<img src="/.within.website/x/cmd/anubis/static/img/happy.webp">')).toBe(
      true,
    )
    expect(isBotChallenge('<script>window._cf_chl_opt={cvId:"3"}</script>')).toBe(true)
    expect(isBotChallenge('<title>Just a moment...</title>')).toBe(true)
  })

  it('does not flag an article about them or a normal Cloudflare page', () => {
    expect(
      isBotChallenge(
        '<title>Anubis blocks AI scrapers with proof-of-work</title><p>Anubis uses a proof-of-work challenge.</p>',
      ),
    ).toBe(false)
    expect(
      isBotChallenge('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'),
    ).toBe(false)
  })
})
