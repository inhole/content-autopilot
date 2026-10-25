import { charCount, type Scene } from './types.ts'

// Turns scenes into a timeline of frames (one per subtitle chunk) and the narration track layout.
// Every sentence is synthesized on its own, so its exact length is known and the subtitles line up
// without word timestamps (docs/plans/video.md 3-3).

/** Silence before the first sentence. */
export const LEAD_MS = 250
/** Pause after a sentence inside a scene, and after the last sentence of a scene. */
export const SENTENCE_GAP_MS = 150
export const SCENE_GAP_MS = 350
/** The closing source card has no narration. */
export const CLOSING_MS = 2_500
/** A subtitle longer than this (about 3 lines in the box) is split. */
export const SUBTITLE_MAX = 42

/** Splits narration into sentences: after . ! ? … or at line breaks. */
export function splitSentences(narration: string): string[] {
  return narration
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Splits a long sentence into subtitle chunks at a comma or space near the middle. */
export function chunkSubtitle(sentence: string, max = SUBTITLE_MAX): string[] {
  const chars = [...sentence]
  if (chars.length <= max) return [sentence]
  const mid = Math.floor(chars.length / 2)
  let cut = -1
  // Prefer a comma, then a space, closest to the middle.
  for (const pattern of [/[,，]/, /\s/]) {
    for (let d = 0; d < mid && cut < 0; d++) {
      for (const i of [mid + d, mid - d]) {
        if (i > 0 && i < chars.length - 1 && pattern.test(chars[i] ?? '')) {
          cut = i + 1
          break
        }
      }
    }
    if (cut >= 0) break
  }
  if (cut < 0) cut = mid
  const head = chars.slice(0, cut).join('').trim()
  const tail = chars.slice(cut).join('').trim()
  return [...chunkSubtitle(head, max), ...chunkSubtitle(tail, max)]
}

/** One frame: shown for `durationMs`. `scene` is the scene index, or scenes.length for the source card. */
export type Cue = { scene: number; subtitle: string | null; durationMs: number }

/** The narration track: sentence audio (by scene and sentence index) and silences, in order. */
export type AudioPiece =
  | { kind: 'speech'; scene: number; sentence: number }
  | { kind: 'silence'; ms: number }

export type Timeline = { cues: Cue[]; audio: AudioPiece[]; totalMs: number }

/**
 * Lays out frames and audio. `durations[s][k]` is the audio length (ms) of sentence k of scene s,
 * in the order splitSentences returns them. A sentence's frame lasts for its audio plus the pause
 * after it; a sentence split into several subtitle chunks shares that time by character count.
 */
export function buildTimeline(scenes: Scene[], durations: number[][]): Timeline {
  const cues: Cue[] = []
  const audio: AudioPiece[] = [{ kind: 'silence', ms: LEAD_MS }]
  let first = true
  scenes.forEach((scene, s) => {
    const sentences = splitSentences(scene.narration)
    if (sentences.length === 0) throw new Error(`scene ${s + 1} has no narration`)
    sentences.forEach((sentence, k) => {
      const speech = durations[s]?.[k]
      if (speech === undefined) throw new Error(`missing duration for scene ${s} sentence ${k}`)
      const gap = k === sentences.length - 1 ? SCENE_GAP_MS : SENTENCE_GAP_MS
      audio.push({ kind: 'speech', scene: s, sentence: k }, { kind: 'silence', ms: gap })
      const span = speech + gap + (first ? LEAD_MS : 0)
      first = false
      const chunks = chunkSubtitle(sentence)
      const total = chunks.reduce((n, c) => n + charCount(c), 0)
      let left = span
      chunks.forEach((chunk, i) => {
        const ms = i === chunks.length - 1 ? left : Math.round((span * charCount(chunk)) / total)
        left -= ms
        cues.push({ scene: s, subtitle: chunk, durationMs: ms })
      })
    })
  })
  cues.push({ scene: scenes.length, subtitle: null, durationMs: CLOSING_MS })
  audio.push({ kind: 'silence', ms: CLOSING_MS })
  return { cues, audio, totalMs: cues.reduce((n, c) => n + c.durationMs, 0) }
}
