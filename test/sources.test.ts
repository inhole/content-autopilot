import { describe, expect, it } from 'vitest'
import { TransientFetchError } from '../src/pipeline/article.ts'
import { fetchHnComments, gatherSources, resolveGeekNews } from '../src/pipeline/sources.ts'

const gnPage = (href: string, body = '<ul><li><strong>요약</strong> 첫째</li><li>둘째</li></ul>') =>
  `<html><body><div class='topictitle link'><a href='${href}' class='bold ud topic-title-link'><h1>제목</h1></a></div>
  <div class=topic_contents><section id='topic_contents' class='article-content'>${body}</section></div></body></html>`

describe('resolveGeekNews', () => {
  it('extracts the original link and the summary text', () => {
    const out = resolveGeekNews(gnPage('https://github.com/tarwin/tinyjsapp'))
    expect(out.originalUrl).toBe('https://github.com/tarwin/tinyjsapp')
    expect(out.summary).toContain('요약 첫째')
    expect(out.summary).toContain('둘째')
  })

  it('has no original URL for relative or GeekNews self links', () => {
    expect(resolveGeekNews(gnPage('topic?id=1')).originalUrl).toBeUndefined()
    expect(resolveGeekNews(gnPage('/topic?id=1')).originalUrl).toBeUndefined()
    expect(resolveGeekNews(gnPage('https://news.hada.io/topic?id=1')).originalUrl).toBeUndefined()
    expect(resolveGeekNews(gnPage('javascript:void(0)')).originalUrl).toBeUndefined()
  })

  it('returns an empty result when the page has neither', () => {
    expect(resolveGeekNews('<html><body>nothing</body></html>')).toEqual({})
  })
})

const hnJson = {
  children: [
    { text: '<p>First &amp; best</p><p>second paragraph <a href="x">link</a></p>', author: 'a' },
    { text: null, author: 'deleted' },
    { text: 'x'.repeat(900), author: 'b', points: null },
    { text: 'c3' },
    { text: 'c4' },
    { text: 'c5' },
    { text: 'c6' },
  ],
}

const jsonFetch = (body: unknown, ok = true) =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch

describe('fetchHnComments', () => {
  const url = 'https://news.ycombinator.com/item?id=42'

  it('returns plain-text, truncated, limited comments in API order', async () => {
    const out = await fetchHnComments(url, jsonFetch(hnJson))
    expect(out).toHaveLength(5)
    expect(out[0]).toBe('First & best\n\nsecond paragraph link')
    expect(out[1]).toHaveLength(400)
    expect(out[2]).toBe('c3')
  })

  it('caps the total size', async () => {
    const big = { children: Array.from({ length: 5 }, () => ({ text: 'y'.repeat(1000) })) }
    const out = await fetchHnComments(url, jsonFetch(big))
    expect(out.length).toBeLessThanOrEqual(4)
  })

  it('returns [] on bad URLs, HTTP errors, bad JSON and network failures', async () => {
    expect(await fetchHnComments(null, jsonFetch(hnJson))).toEqual([])
    expect(await fetchHnComments('https://example.com/item?id=1', jsonFetch(hnJson))).toEqual([])
    expect(
      await fetchHnComments('https://news.ycombinator.com/item?id=x', jsonFetch(hnJson)),
    ).toEqual([])
    expect(await fetchHnComments(url, jsonFetch(hnJson, false))).toEqual([])
    expect(await fetchHnComments(url, jsonFetch({ children: 'nope' }))).toEqual([])
    const boom = (async () => {
      throw new Error('network')
    }) as typeof fetch
    expect(await fetchHnComments(url, boom)).toEqual([])
  })
})

describe('gatherSources', () => {
  const long = 'z'.repeat(300)
  const gnTopic = {
    title: 't',
    url: 'https://news.hada.io/topic?id=1',
    discussion_url: null,
    feed_summary: null,
  }
  const htmlFetch = (html: string) => (async () => new Response(html)) as typeof fetch

  it('reads the original article behind a GeekNews topic and keeps the summary as aux', async () => {
    const asked: string[] = []
    const out = await gatherSources(gnTopic, {
      fetchFn: htmlFetch(gnPage('https://example.org/post', `<p>${long}</p>`)),
      fetchArticle: async (u) => {
        asked.push(u)
        return { title: '', text: 'original body' }
      },
    })
    expect(asked).toEqual(['https://example.org/post'])
    expect(out?.body).toBe('original body')
    expect(out?.sourceUrl).toBe('https://example.org/post')
    expect(out?.aux.map((a) => a.label)).toEqual(['GeekNews 요약 (참고)'])
  })

  it('falls back to the GeekNews summary when the original is unreadable', async () => {
    const out = await gatherSources(gnTopic, {
      fetchFn: htmlFetch(gnPage('https://example.org/post', `<p>${long}</p>`)),
      fetchArticle: async () => null,
    })
    expect(out?.body).toBe(long)
    expect(out?.sourceUrl).toBe('https://example.org/post')
    expect(out?.aux).toEqual([])
  })

  it('rethrows a transient failure when there is no usable fallback', async () => {
    await expect(
      gatherSources(
        { ...gnTopic, url: 'https://example.org/a' },
        {
          fetchArticle: async () => {
            throw new TransientFetchError('503')
          },
        },
      ),
    ).rejects.toBeInstanceOf(TransientFetchError)
  })

  it('uses the feed summary instead of retrying when one is usable', async () => {
    const out = await gatherSources(
      { ...gnTopic, url: 'https://example.org/a', feed_summary: long },
      {
        fetchArticle: async () => {
          throw new TransientFetchError('503')
        },
      },
    )
    expect(out?.body).toBe(long)
    expect(out?.sourceUrl).toBe('https://example.org/a')
  })

  it('returns null for a permanently unreadable page and uses the title for URL-less topics', async () => {
    const dead = { fetchArticle: async () => null }
    expect(await gatherSources({ ...gnTopic, url: 'https://example.org/a' }, dead)).toBeNull()
    expect(await gatherSources({ ...gnTopic, url: null, title: 'manual' }, dead)).toMatchObject({
      body: 'manual',
      sourceUrl: null,
    })
  })

  it('adds HN comments as labeled aux context', async () => {
    const out = await gatherSources(
      {
        title: 't',
        url: 'https://example.org/a',
        discussion_url: 'https://news.ycombinator.com/item?id=42',
        feed_summary: null,
      },
      { fetchArticle: async () => ({ title: '', text: 'body' }), fetchFn: jsonFetch(hnJson) },
    )
    expect(out?.aux[0]?.label).toBe('HN 댓글 (개발자 반응, 사실 근거 아님)')
    expect(out?.aux[0]?.text).toContain('1. First & best')
  })
})
