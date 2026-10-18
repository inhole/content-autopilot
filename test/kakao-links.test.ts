import { describe, expect, it } from 'vitest'
import { extractRevuCampaignLinks } from '../src/campaigns/kakao-links.ts'

const ids = (text: string) => extractRevuCampaignLinks(text).map((l) => l.externalId)

describe('extractRevuCampaignLinks', () => {
  it('canonicalises url forms', () => {
    for (const text of [
      'https://www.revu.net/campaign/123',
      'http://revu.net/campaign/123',
      'revu.net/campaign/123',
      'www.revu.net/campaign/123',
      'https://m.revu.net/campaign/123',
      'HTTPS://WWW.REVU.NET/campaign/123',
    ]) {
      expect(extractRevuCampaignLinks(text)).toEqual([
        { externalId: '123', url: 'https://www.revu.net/campaign/123' },
      ])
    }
  })

  it('ignores query strings, fragments and trailing punctuation', () => {
    expect(ids('https://www.revu.net/campaign/42?utm_source=kakao&a=1')).toEqual(['42'])
    expect(ids('https://www.revu.net/campaign/42#top')).toEqual(['42'])
    expect(ids('(https://www.revu.net/campaign/42).')).toEqual(['42'])
    expect(ids('보세요 https://www.revu.net/campaign/42, 감사')).toEqual(['42'])
    expect(ids('https://www.revu.net/campaign/42/')).toEqual(['42'])
  })

  it('handles Korean text glued after the url', () => {
    expect(ids('https://www.revu.net/campaign/42신청하세요')).toEqual(['42'])
    expect(ids('링크:revu.net/campaign/42입니다')).toEqual(['42'])
  })

  it('dedupes by id and keeps order', () => {
    const text = `
      revu.net/campaign/9
      https://www.revu.net/campaign/3
      https://m.revu.net/campaign/9?x=1
      revu.net/campaign/5`
    expect(ids(text)).toEqual(['9', '3', '5'])
  })

  it('finds several links on one line', () => {
    expect(ids('revu.net/campaign/1 revu.net/campaign/2')).toEqual(['1', '2'])
  })

  it('rejects other paths, hosts and non-numeric ids', () => {
    expect(ids('https://www.revu.net/campaign/abc')).toEqual([])
    expect(ids('https://www.revu.net/mypage/campaigns?status=request')).toEqual([])
    expect(ids('https://www.revu.net/campaign/')).toEqual([])
    expect(ids('https://notrevu.net/campaign/5')).toEqual([])
    expect(ids('https://evil.revu.net/campaign/5')).toEqual([])
    expect(ids('https://example.com/campaign/5')).toEqual([])
    expect(ids('no links here')).toEqual([])
    expect(ids('')).toEqual([])
  })
})
