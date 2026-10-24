import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  CLOSING_MS,
  chunkSubtitle,
  LEAD_MS,
  SCENE_GAP_MS,
  SENTENCE_GAP_MS,
  SUBTITLE_MAX,
  splitSentences,
} from '../src/video/subtitles.ts'
import { charCount } from '../src/video/types.ts'
import {
  parseWav,
  pcmDurationMs,
  pipelinePcm,
  SAMPLE_RATE,
  silence,
  writeWav,
} from '../src/video/wav.ts'

describe('splitSentences', () => {
  it('splits after sentence punctuation and at line breaks', () => {
    expect(splitSentences('첫 문장이야. 두 번째야! 정말?\n줄바꿈 문장')).toEqual([
      '첫 문장이야.',
      '두 번째야!',
      '정말?',
      '줄바꿈 문장',
    ])
  })

  it('keeps decimals and versions together', () => {
    expect(splitSentences('버전 2.5가 나왔어. 좋아.')).toEqual(['버전 2.5가 나왔어.', '좋아.'])
  })
})

describe('chunkSubtitle', () => {
  it('leaves short sentences alone', () => {
    expect(chunkSubtitle('짧은 문장이야.')).toEqual(['짧은 문장이야.'])
  })

  it('splits long sentences near the middle, preferring a comma, within the limit', () => {
    const long =
      '사이드 프로젝트 정도면 유료 플랜 없이도 충분할 것 같은데, 팀 단위로 쓰면 이야기가 꽤 달라질 수 있어.'
    const chunks = chunkSubtitle(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.endsWith(',')).toBe(true)
    for (const c of chunks) expect(charCount(c)).toBeLessThanOrEqual(SUBTITLE_MAX)
    expect(chunks.join(' ')).toBe(long)
  })
})

describe('buildTimeline', () => {
  const scenes = [
    { heading: '훅', narration: '첫 문장. 둘째 문장.' },
    { heading: '본문', narration: '셋째 문장.' },
  ]

  it('lays frames and audio so both last exactly as long', () => {
    const t = buildTimeline(scenes, [[1000, 2000], [1500]])
    const audioMs = t.audio.reduce((n, p) => n + (p.kind === 'silence' ? p.ms : 0), 0) + 4500
    expect(t.totalMs).toBe(audioMs)
    expect(t.totalMs).toBe(
      LEAD_MS + 1000 + SENTENCE_GAP_MS + 2000 + SCENE_GAP_MS + 1500 + SCENE_GAP_MS + CLOSING_MS,
    )
    expect(t.cues.map((c) => c.scene)).toEqual([0, 0, 1, 2])
    expect(t.cues[0]?.durationMs).toBe(LEAD_MS + 1000 + SENTENCE_GAP_MS)
    expect(t.cues.at(-1)).toEqual({ scene: 2, subtitle: null, durationMs: CLOSING_MS })
  })

  it('shares a long sentence between its chunks without losing time', () => {
    const long =
      '사이드 프로젝트 정도면 유료 플랜 없이도 충분할 것 같은데, 팀 단위로 쓰면 이야기가 꽤 달라질 수 있어.'
    const t = buildTimeline([{ heading: 'h', narration: long }], [[5000]])
    const speechCues = t.cues.filter((c) => c.subtitle)
    expect(speechCues.length).toBeGreaterThan(1)
    expect(speechCues.reduce((n, c) => n + c.durationMs, 0)).toBe(LEAD_MS + 5000 + SCENE_GAP_MS)
  })

  it('rejects a scene without narration and a missing duration', () => {
    expect(() => buildTimeline([{ heading: 'h', narration: ' ' }], [[]])).toThrow(/no narration/)
    expect(() => buildTimeline(scenes, [[1000]])).toThrow(/missing duration/)
  })
})

describe('wav', () => {
  it('round-trips PCM through writeWav and parseWav', () => {
    const pcm = silence(500)
    const info = parseWav(writeWav(pcm))
    expect(info).toMatchObject({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 })
    expect(pcmDurationMs(pipelinePcm(info))).toBe(500)
  })

  it('walks chunks instead of assuming a 44-byte header', () => {
    const wav = writeWav(silence(100))
    // Insert an odd-sized LIST chunk (padded to even) between fmt and data.
    const list = Buffer.concat([
      Buffer.from('LIST'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc\0'),
    ])
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)])
    expect(parseWav(withList).data.length).toBe(silence(100).length)
  })

  it('refuses non-PCM and other sample formats', () => {
    const wav = writeWav(silence(10))
    const float = Buffer.from(wav)
    float.writeUInt16LE(3, 20)
    expect(() => parseWav(float)).toThrow(/PCM only/)
    const stereo = Buffer.from(wav)
    stereo.writeUInt16LE(2, 22)
    expect(() => pipelinePcm(parseWav(stereo))).toThrow(/unexpected audio format/)
    expect(() => parseWav(Buffer.from('nope'))).toThrow(/RIFF/)
  })
})
