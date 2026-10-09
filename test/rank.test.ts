import { describe, expect, it } from 'vitest'
import { pickTop, resolveDuplicates } from '../src/pipeline/rank.ts'

const s = (id: number, score: number, duplicate_of: number | null = null) => ({
  id,
  score,
  duplicate_of,
})

describe('resolveDuplicates', () => {
  const known = new Set([1, 2, 3, 100])

  it('keeps valid references to candidates and recent topics', () => {
    const out = resolveDuplicates([s(1, 8), s(2, 7, 1), s(3, 9, 100)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([null, 1, 100])
  })

  it('drops unknown and self references', () => {
    const out = resolveDuplicates([s(1, 8, 999), s(2, 7, 2)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([null, null])
  })

  it('keeps the higher-scored side of a mutual pair', () => {
    const out = resolveDuplicates([s(1, 6, 2), s(2, 9, 1)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([2, null])
  })

  it('breaks a tied mutual pair by lower id', () => {
    const out = resolveDuplicates([s(2, 7, 1), s(1, 7, 2)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([1, null])
  })
})

describe('pickTop', () => {
  it('takes a fixed count of the best non-duplicate candidates', () => {
    const scores = [s(1, 5), s(2, 9, 3), s(3, 8), s(4, 7), s(99, 10)]
    expect(pickTop(scores, new Set([1, 2, 3, 4]), 2)).toEqual([3, 4])
  })
})
