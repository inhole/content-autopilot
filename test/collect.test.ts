import { describe, expect, it } from 'vitest'
import { normalizeItem } from '../src/pipeline/collect.ts'

const base = 'https://example.com/blog/'

describe('normalizeItem', () => {
  it('accepts a normal item', () => {
    const out = normalizeItem(
      { title: ' Hi ', link: 'https://example.com/a', isoDate: '2026-01-01T00:00:00Z' },
      base,
    )
    expect(out?.title).toBe('Hi')
    expect(out?.url).toBe('https://example.com/a')
    expect(out?.publishedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('resolves relative links against the base', () => {
    expect(normalizeItem({ title: 't', link: '/posts/1' }, base)?.url).toBe(
      'https://example.com/posts/1',
    )
  })

  it('rejects non-http(s) and unparseable links', () => {
    expect(normalizeItem({ title: 't', link: 'javascript:alert(1)' }, base)).toBeNull()
    expect(normalizeItem({ title: 't', link: 'ftp://example.com/x' }, base)).toBeNull()
    expect(normalizeItem({ title: 't', link: 'http://' }, base)).toBeNull()
    expect(normalizeItem({ title: 't', link: '/x' }, 'not a url')).toBeNull()
  })

  it('rejects missing title or link', () => {
    expect(normalizeItem({ title: ' ', link: 'https://example.com/a' }, base)).toBeNull()
    expect(normalizeItem({ title: 't' }, base)).toBeNull()
  })

  it('skips items whose fields are not strings', () => {
    // rss-parser turns e.g. <title xml:lang="ko"/> into an object.
    const objectTitle = { _: '', $: { 'xml:lang': 'ko' } }
    expect(normalizeItem({ title: objectTitle, link: '/a' }, base)).toBeNull()
    expect(normalizeItem({ title: 't', link: { href: '/a' } }, base)).toBeNull()
    expect(
      normalizeItem({ title: 't', link: '/a', isoDate: 123, contentSnippet: {} }, base),
    ).toMatchObject({ publishedAt: null, summary: null })
  })

  it('turns an invalid date into null', () => {
    expect(
      normalizeItem({ title: 't', link: '/a', isoDate: 'garbage' }, base)?.publishedAt,
    ).toBeNull()
  })
})
