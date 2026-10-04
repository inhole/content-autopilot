import { describe, expect, it } from 'vitest'
import { normalizeUrl, urlHash } from '../src/lib/url.ts'

describe('normalizeUrl', () => {
  it('drops tracking params, fragment, www and trailing slash', () => {
    expect(normalizeUrl('https://WWW.Example.com/a/b/?utm_source=x&id=2#top')).toBe(
      'https://example.com/a/b?id=2',
    )
  })

  it('sorts remaining query params so order does not matter', () => {
    expect(urlHash('https://example.com/p?b=2&a=1')).toBe(urlHash('https://example.com/p?a=1&b=2'))
  })

  it('keeps the root path', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/')
  })
})
