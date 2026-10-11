import { describe, expect, it } from 'vitest'
import { composeChain, ctaSuffix, lastFollowupLimit } from '../src/pipeline/parts.ts'
import { encodeChainRetry, parseChainRetry } from '../src/review/telegram.ts'

const base = { text: 'main', topicTag: 'AI', sourceUrl: 'https://example.com/a' }

describe('composeChain', () => {
  it('keeps the link on a single post and never adds the CTA', () => {
    expect(composeChain({ ...base, followups: [], cta: '팔로우' })).toEqual([
      { text: 'main', topicTag: 'AI', linkAttachment: 'https://example.com/a' },
    ])
  })

  it('moves the link to the last follow-up and appends the CTA there', () => {
    expect(composeChain({ ...base, followups: ['two', 'three'], cta: '팔로우' })).toEqual([
      { text: 'main', topicTag: 'AI' },
      { text: 'two' },
      { text: 'three\n\n팔로우', linkAttachment: 'https://example.com/a' },
    ])
  })

  it('drops the CTA when it no longer fits', () => {
    const long = 'x'.repeat(495)
    const [, last] = composeChain({ ...base, followups: [long], cta: '팔로우해 주세요' })
    expect(last?.text).toBe(long)
  })

  it('works without a CTA', () => {
    const [, last] = composeChain({ ...base, followups: ['two'], cta: undefined })
    expect(last?.text).toBe('two')
  })
})

describe('CTA budget', () => {
  it('reserves the separator and the CTA', () => {
    expect(ctaSuffix('팔로우')).toBe('\n\n팔로우')
    expect(ctaSuffix(undefined)).toBe('')
    expect(lastFollowupLimit('팔로우')).toBe(495)
    expect(lastFollowupLimit(undefined)).toBe(500)
  })
})

describe('chain retry callback', () => {
  it('round-trips', () => {
    expect(parseChainRetry(encodeChainRetry(42))).toBe(42)
    expect(parseChainRetry('approve:42')).toBeNull()
    expect(parseChainRetry('chainretry:x')).toBeNull()
  })
})
