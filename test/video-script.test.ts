import { describe, expect, it, vi } from 'vitest'
import { buildScriptPrompt, fitScript, formatScript, writeScript } from '../src/video/script.ts'
import {
  captionProblems,
  cleanHashtags,
  composeCaption,
  LIMITS,
  narrationLength,
  sceneEditProblem,
  sourceLabel,
  youtubeTitle,
} from '../src/video/types.ts'

const scene = (n: number, chars = 60) => ({
  heading: `장면 ${n}`,
  narration: `${'가'.repeat(chars - 1)}.`,
})

const raw = (scenes = [scene(1), scene(2), scene(3), scene(4)]) => ({
  title: '제목',
  caption: '캡션이야.',
  hashtags: ['#AI', '개발자', 'AI', 'with space'],
  scenes,
})

describe('fitScript', () => {
  it('cuts short fields, cleans hashtags and drops empty scenes', () => {
    const { script, problems } = fitScript({
      ...raw([...[1, 2, 3].map((n) => scene(n)), { heading: '  ', narration: 'x' }]),
      title: 't'.repeat(100),
    })
    expect(problems).toEqual([])
    expect([...script.title].length).toBe(LIMITS.title)
    expect(script.hashtags).toEqual(['AI', '개발자', 'withspace'])
    expect(script.scenes).toHaveLength(3)
  })

  it('reports too few scenes and an over-long narration', () => {
    expect(fitScript(raw([scene(1)])).problems[0]).toMatch(/장면이 1개/)
    const long = [1, 2, 3, 4].map((n) => scene(n, 100))
    expect(fitScript(raw(long)).problems[0]).toMatch(/내레이션 합계/)
  })

  it('trims a trailing period from headings and keeps at most 5 scenes', () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => ({ ...scene(n, 30), heading: `문구 ${n}.` }))
    const { script } = fitScript(raw(many))
    expect(script.scenes).toHaveLength(LIMITS.maxScenes)
    expect(script.scenes[0]?.heading).toBe('문구 1')
  })
})

describe('writeScript', () => {
  it('shortens an over-long narration once', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(raw([1, 2, 3, 4].map((n) => scene(n, 90))))
      .mockResolvedValueOnce({ scenes: [1, 2, 3, 4].map((n) => scene(n, 60)) })
    const { script, generation } = await writeScript(
      { postText: '글', followups: [], topicTitle: '주제', sourceLabel: null },
      { chat: chat as never, model: 'm' },
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(narrationLength(script.scenes)).toBe(240)
    expect(generation).toEqual({ model: 'm', prompt_version: 1, feedback: null })
  })

  it('throws when the script still breaks a hard limit', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(raw([1, 2, 3, 4].map((n) => scene(n, 120))))
      .mockResolvedValueOnce({ scenes: [1, 2, 3, 4].map((n) => scene(n, 110)) })
    await expect(
      writeScript(
        { postText: '글', followups: [], topicTitle: '주제', sourceLabel: null },
        { chat: chat as never },
      ),
    ).rejects.toThrow(/video script rejected/)
  })
})

describe('buildScriptPrompt', () => {
  it('includes the post, follow-ups, source and feedback with the previous script', () => {
    const prompt = buildScriptPrompt({
      postText: '본 글',
      followups: ['답글 하나'],
      topicTitle: '주제',
      sourceLabel: 'github.blog',
      previous: { title: '옛 제목', caption: 'c', hashtags: [], scenes: [scene(1)] },
      feedback: '더 짧게',
    })
    expect(prompt).toContain('본 글')
    expect(prompt).toContain('[이어지는 답글 1]\n답글 하나')
    expect(prompt).toContain('출처: github.blog')
    expect(prompt).toContain('옛 제목')
    expect(prompt).toContain('더 짧게')
  })

  it('leaves the previous script out without feedback', () => {
    const prompt = buildScriptPrompt({
      postText: '본 글',
      followups: [],
      topicTitle: '주제',
      sourceLabel: null,
      previous: { title: '옛 제목', caption: 'c', hashtags: [], scenes: [scene(1)] },
    })
    expect(prompt).not.toContain('옛 제목')
  })
})

describe('captions and titles', () => {
  it('appends the source and hashtags in code', () => {
    expect(
      composeCaption({ caption: '본문', sourceUrl: 'https://a.dev/x', hashtags: ['AI', '개발'] }),
    ).toBe('본문\n\n출처: https://a.dev/x\n\n#AI #개발')
  })

  it('checks the YouTube description in UTF-8 bytes, not characters', () => {
    // 1,700 Hangul chars = 5,100 bytes: fine for Instagram (2,200 chars), too long for YouTube.
    expect(captionProblems('가'.repeat(1700))).toEqual([expect.stringMatching(/YouTube/)])
    expect(captionProblems('a'.repeat(2300))).toEqual([expect.stringMatching(/Instagram/)])
  })

  it('makes YouTube titles safe and short', () => {
    expect(youtubeTitle('<b>제목</b>')).toBe('‹b›제목‹/b›')
    expect([...youtubeTitle('가'.repeat(150))].length).toBe(100)
  })

  it('cleans hashtags and derives the source label', () => {
    expect(cleanHashtags(['#a', 'a', '', 'b c', 'd', 'e', 'f', 'g'])).toEqual([
      'a',
      'bc',
      'd',
      'e',
      'f',
    ])
    expect(sourceLabel('https://www.github.blog/x')).toBe('github.blog')
    expect(sourceLabel(null)).toBeNull()
  })
})

describe('sceneEditProblem', () => {
  const scenes = [1, 2, 3].map((n) => scene(n, 100))
  it('validates index, heading and narration limits', () => {
    expect(sceneEditProblem('heading', '짧은 문구', scenes, 2)).toBeNull()
    expect(sceneEditProblem('heading', 'x', scenes, 4)).toMatch(/4번 장면이 없어요/)
    expect(sceneEditProblem('heading', '가'.repeat(19), scenes, 1)).toMatch(/18자/)
    expect(sceneEditProblem('narration', '가'.repeat(141), scenes, 1)).toMatch(/140자/)
    expect(sceneEditProblem('narration', ' ', scenes, 1)).toMatch(/비어/)
  })

  it('checks the narration total after the edit', () => {
    const full = [1, 2, 3].map((n) => scene(n, 120))
    expect(sceneEditProblem('narration', '가'.repeat(130), full, 1)).toMatch(/합계/)
  })
})

describe('formatScript', () => {
  it('numbers scenes and lists caption and hashtags', () => {
    const text = formatScript({
      title: 'T',
      caption: 'C',
      hashtags: ['AI'],
      scenes: [{ heading: 'H', narration: 'N.' }],
    })
    expect(text).toBe('제목: T\n\n[1] H\nN.\n\n캡션: C\n#AI')
  })
})
