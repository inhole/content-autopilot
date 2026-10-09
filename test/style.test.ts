import { describe, expect, it } from 'vitest'
import { buildStylePrompt, type StyleContext } from '../src/pipeline/style.ts'

const empty: StyleContext = { examples: [], recentFirstLines: [], rejectReasons: [] }

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
    })
    expect([...out].length).toBeLessThanOrEqual(1500)
  })
})
