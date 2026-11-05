import { describe, expect, it } from 'vitest'
import { buildStylePrompt, pickTopFirstLines, type StyleContext } from '../src/pipeline/style.ts'

const empty: StyleContext = {
  examples: [],
  recentFirstLines: [],
  recentLastLines: [],
  rejectReasons: [],
}

describe('buildStylePrompt', () => {
  it('returns an empty string on a fresh install', () => {
    expect(buildStylePrompt(empty)).toBe('')
  })
  it('truncates long examples and marks edited ones', () => {
    const out = buildStylePrompt({
      ...empty,
      examples: [{ text: '가'.repeat(600), edited: true }],
    })
    expect(out).toContain('직접 수정함')
    expect(out).toContain('…')
    expect(out).not.toContain('가'.repeat(400))
  })
  it('lists recent first lines', () => {
    const out = buildStylePrompt({ ...empty, recentFirstLines: ['첫 줄 A', '첫 줄 B'] })
    expect(out).toContain('- 첫 줄 A')
    expect(out).toContain('비슷한 첫 줄로 시작하지 마세요')
  })
  it('lists only the most recent last lines, after the first lines', () => {
    const out = buildStylePrompt({
      ...empty,
      recentFirstLines: ['첫 줄 A'],
      recentLastLines: ['끝 1', '끝 2', '끝 3', '끝 4', '끝 5', '끝 6'],
    })
    expect(out).toContain('비슷한 마무리는 피하세요')
    expect(out).toContain('- 끝 5')
    expect(out).not.toContain('- 끝 6')
    expect(out.indexOf('최근 마지막 줄')).toBeGreaterThan(out.indexOf('최근 첫 줄'))
  })
  it('adds guidance only for repeated reasons', () => {
    const out = buildStylePrompt({
      ...empty,
      rejectReasons: [
        { reason: 'boring', count: 3 },
        { reason: 'fact', count: 1 },
      ],
    })
    expect(out).toContain('재미없다')
    expect(out).not.toContain('사실 관계')
  })
  it('caps the total length', () => {
    const out = buildStylePrompt({
      ...empty,
      examples: Array.from({ length: 3 }, () => ({ text: '나'.repeat(280), edited: false })),
      recentFirstLines: Array.from({ length: 10 }, () => '다'.repeat(60)),
      recentLastLines: Array.from({ length: 10 }, () => '라'.repeat(60)),
    })
    expect([...out].length).toBeLessThanOrEqual(2200)
  })
  it('keeps reject guidance within the cap when every list is full', () => {
    const out = buildStylePrompt({
      examples: Array.from({ length: 3 }, () => ({ text: '나'.repeat(280), edited: true })),
      recentFirstLines: Array.from({ length: 10 }, () => '다'.repeat(60)),
      recentLastLines: Array.from({ length: 10 }, () => '라'.repeat(60)),
      rejectReasons: [{ reason: 'boring', count: 3 }],
    })
    expect(out).toContain('재미없다')
  })
})

describe('pickTopFirstLines', () => {
  const rows = (views: number[]) => views.map((v, i) => ({ text: `글 ${i} 첫 줄\n본문`, views: v }))

  it('learns nothing until six posts of the format are measured', () => {
    expect(pickTopFirstLines(rows([1, 2, 3, 4, 500]))).toEqual([])
  })

  it('keeps up to three first lines above the median, best first', () => {
    expect(pickTopFirstLines(rows([1, 2, 3, 40, 300, 90, 5, 6]))).toEqual([
      '글 4 첫 줄',
      '글 5 첫 줄',
      '글 3 첫 줄',
    ])
  })

  it('keeps nothing when every post has the same views', () => {
    expect(pickTopFirstLines(rows([7, 7, 7, 7, 7, 7]))).toEqual([])
  })
})

describe('buildStylePrompt top first lines', () => {
  it('adds the section only when there are lines', () => {
    expect(buildStylePrompt({ ...empty, topFirstLines: [] })).toBe('')
    const out = buildStylePrompt({
      ...empty,
      topFirstLines: ['반응 좋았던 훅'],
      recentFirstLines: ['최근 훅'],
    })
    expect(out).toContain('## 반응 좋았던 첫 줄')
    expect(out).toContain('- 반응 좋았던 훅')
    expect(out.indexOf('반응 좋았던 첫 줄')).toBeLessThan(out.indexOf('최근 첫 줄'))
  })
})
