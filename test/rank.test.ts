import { describe, expect, it } from 'vitest'
import { pickTop, resolveDuplicates, validateScores } from '../src/pipeline/rank.ts'

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

  it('keeps the best member of a 3-cycle as representative', () => {
    const out = resolveDuplicates([s(1, 5, 2), s(2, 9, 3), s(3, 7, 1)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([2, null, 1])
  })

  it('breaks a 4-cycle, tie by lowest id', () => {
    const k = new Set([1, 2, 3, 4])
    const out = resolveDuplicates([s(4, 6, 1), s(3, 6, 4), s(2, 6, 3), s(1, 6, 2)], k)
    expect(out.map((x) => x.duplicate_of)).toEqual([1, 4, 3, null])
  })

  it('keeps a chain that leads into a cycle', () => {
    const k = new Set([1, 2, 3, 4])
    const out = resolveDuplicates([s(4, 9, 1), s(1, 5, 2), s(2, 8, 3), s(3, 6, 1)], k)
    const byId = new Map(out.map((x) => [x.id, x.duplicate_of]))
    expect(byId.get(2)).toBeNull()
    expect(byId.get(1)).toBe(2)
    expect(byId.get(3)).toBe(1)
    expect(byId.get(4)).toBe(1)
  })

  it('leaves a chain ending at a non-duplicate untouched', () => {
    const out = resolveDuplicates([s(1, 5, 2), s(2, 6, 3), s(3, 7)], known)
    expect(out.map((x) => x.duplicate_of)).toEqual([2, 3, null])
  })
})

describe('validateScores', () => {
  const ids = new Set([1, 2, 3])

  it('returns scores for exactly the candidates, ignoring unknown ids', () => {
    const out = validateScores([s(1, 5), s(2, 6), s(3, 7), s(99, 1)], ids)
    expect(out.map((x) => x.id)).toEqual([1, 2, 3])
  })

  it('throws on an empty response', () => {
    expect(() => validateScores([], ids)).toThrow(/missing/)
  })

  it('throws when a candidate is missing', () => {
    expect(() => validateScores([s(1, 5), s(2, 6)], ids)).toThrow(/missing 1/)
  })

  it('throws on repeated ids', () => {
    expect(() => validateScores([s(1, 5), s(1, 6), s(2, 6), s(3, 1)], ids)).toThrow(/repeats/)
  })
})

describe('pickTop', () => {
  it('takes a fixed count of the best non-duplicate candidates', () => {
    const scores = [s(1, 5), s(2, 9, 3), s(3, 8), s(4, 7), s(99, 10)]
    expect(pickTop(scores, new Set([1, 2, 3, 4]), 2)).toEqual([3, 4])
  })

  it('never returns the same id twice', () => {
    expect(pickTop([s(1, 9), s(1, 9), s(2, 5)], new Set([1, 2]), 2)).toEqual([1, 2])
  })
})
