import { describe, expect, it } from 'vitest'
import { parseProfileInput } from '../src/web/ops.ts'

const valid = {
  about: 'about',
  interests: ['a'],
  preferKeywords: [],
  excludeKeywords: [],
  excludeBrands: [],
  maxCompetition: null,
  minPriceWon: null,
  review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
  disclosure: null,
}

const fieldsOf = (patch: Record<string, unknown>) => {
  const r = parseProfileInput({ ...valid, ...patch })
  return r.ok ? null : r.fields
}

describe('parseProfileInput', () => {
  it('omits unset optional values', () => {
    expect(parseProfileInput(valid)).toEqual({
      ok: true,
      profile: {
        about: 'about',
        interests: ['a'],
        preferKeywords: [],
        excludeKeywords: [],
        excludeBrands: [],
        review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
      },
    })
  })

  it('trims strings, drops empty list items and dedupes in order', () => {
    const r = parseProfileInput({
      ...valid,
      about: '  hi  ',
      interests: [' b ', 'a', '', '  ', 'b', 'a', 'c'],
      disclosure: '  광고 포함  ',
      maxCompetition: 12.5,
      minPriceWon: 9000,
    })
    expect(r.ok && r.profile).toMatchObject({
      about: 'hi',
      interests: ['b', 'a', 'c'],
      disclosure: '광고 포함',
      maxCompetition: 12.5,
      minPriceWon: 9000,
    })
  })

  it('treats a blank disclosure as none', () => {
    const r = parseProfileInput({ ...valid, disclosure: '   ' })
    expect(r.ok && 'disclosure' in r.profile).toBe(false)
  })

  it('enforces text and list limits with dotted paths', () => {
    expect(fieldsOf({ about: 'x'.repeat(501) })).toEqual(['about'])
    expect(fieldsOf({ about: '가'.repeat(500) })).toBeNull()
    expect(fieldsOf({ review: { ...valid.review, tone: 'x'.repeat(201) } })).toEqual([
      'review.tone',
    ])
    expect(fieldsOf({ disclosure: 'x'.repeat(201) })).toEqual(['disclosure'])
    expect(fieldsOf({ interests: ['a', 'b', 'c', 'x'.repeat(51)] })).toEqual(['interests.3'])
    expect(fieldsOf({ excludeKeywords: Array.from({ length: 51 }, (_, i) => `k${i}`) })).toEqual([
      'excludeKeywords',
    ])
    expect(fieldsOf({ excludeKeywords: Array.from({ length: 50 }, (_, i) => `k${i}`) })).toBeNull()
    expect(fieldsOf({ review: { ...valid.review, points: ['p', 'x'.repeat(51)] } })).toEqual([
      'review.points.1',
    ])
  })

  it('validates numbers', () => {
    expect(fieldsOf({ maxCompetition: 0 })).toEqual(['maxCompetition'])
    expect(fieldsOf({ minPriceWon: 1.5 })).toEqual(['minPriceWon'])
    expect(fieldsOf({ minPriceWon: 0 })).toEqual(['minPriceWon'])
    expect(fieldsOf({ minPriceWon: '100' })).toEqual(['minPriceWon'])
    expect(fieldsOf({ review: { ...valid.review, minChars: 9 } })).toEqual(['review.minChars'])
    expect(fieldsOf({ review: { ...valid.review, minChars: 10, maxChars: 49 } })).toEqual([
      'review.maxChars',
    ])
    expect(fieldsOf({ review: { ...valid.review, maxChars: 4001 } })).toEqual(['review.maxChars'])
    expect(fieldsOf({ review: { ...valid.review, maxChars: 4000 } })).toBeNull()
  })

  it('requires minChars < maxChars', () => {
    expect(fieldsOf({ review: { ...valid.review, minChars: 100, maxChars: 100 } })).toEqual([
      'review.minChars',
    ])
    expect(fieldsOf({ review: { ...valid.review, minChars: 99, maxChars: 100 } })).toBeNull()
  })

  it('requires the disclosure to leave room within maxChars', () => {
    const review = { ...valid.review, minChars: 10, maxChars: 50 }
    // 38 chars + 2 gap = 40 reserved -> body max 10: just enough
    expect(fieldsOf({ review, disclosure: 'x'.repeat(38) })).toBeNull()
    expect(fieldsOf({ review, disclosure: 'x'.repeat(39) })).toEqual(['disclosure'])
  })

  it('rejects wrong shapes', () => {
    expect(parseProfileInput(null)).toMatchObject({ ok: false })
    expect(fieldsOf({ interests: 'a' })).toEqual(['interests'])
    expect(fieldsOf({ about: 5 })).toEqual(['about'])
    expect(fieldsOf({ review: undefined })).toEqual(['review'])
  })
})
