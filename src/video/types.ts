// Short-form videos (docs/plans/video.md). Shared types, limits and text assembly.

export type VideoStatus =
  | 'SCRIPTING'
  | 'RENDERING'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED'

export type Platform = 'REELS' | 'SHORTS'
export type PublicationStatus = 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED'

export const PLATFORM_LABELS: Record<Platform, string> = {
  REELS: 'Instagram Reels',
  SHORTS: 'YouTube Shorts',
}

/** VIDEO_PLATFORMS values → publication platforms. */
export const toPlatform = (p: 'reels' | 'shorts'): Platform => (p === 'reels' ? 'REELS' : 'SHORTS')

export type Scene = { heading: string; narration: string }

export const LIMITS = {
  minScenes: 3,
  maxScenes: 5,
  heading: 18,
  title: 60,
  caption: 300,
  hashtags: 5,
  /** Narration total, in characters (about 25-45 seconds of Korean TTS). */
  narrationMin: 180,
  narrationMax: 330,
  /** Over this the script is shortened once; still over it fails. */
  narrationHard: 360,
  /** Per-scene narration cap for owner edits, so one scene cannot blow the length. */
  sceneNarration: 140,
} as const

/** YouTube limits: title in characters, description in UTF-8 bytes; neither may contain < or >. */
export const YOUTUBE_TITLE_LIMIT = 100
export const YOUTUBE_DESCRIPTION_BYTES = 5000
/** Instagram caption limit (characters). */
export const INSTAGRAM_CAPTION_LIMIT = 2200

export const charCount = (text: string) => [...text].length
export const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')

export const narrationLength = (scenes: Scene[]) =>
  scenes.reduce((n, s) => n + charCount(s.narration), 0)

/** YouTube rejects < and > in titles and descriptions. */
export const youtubeSafe = (text: string) => text.replace(/</g, '‹').replace(/>/g, '›')

/** Normalizes model or owner hashtags: no `#`, no spaces, deduplicated, at most LIMITS.hashtags. */
export function cleanHashtags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, '').trim()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, LIMITS.hashtags)
}

/** Short label for the source card and caption, e.g. `github.blog`. */
export function sourceLabel(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * The caption that goes out: the model's (or owner's) text, then the source link and hashtags.
 * Added by code so the source is never left out (docs/decisions.md 12, same principle).
 */
export function composeCaption(v: {
  caption: string
  sourceUrl: string | null
  hashtags: string[]
}): string {
  const lines = [v.caption.trim()]
  if (v.sourceUrl) lines.push('', `출처: ${v.sourceUrl}`)
  if (v.hashtags.length) lines.push('', v.hashtags.map((t) => `#${t}`).join(' '))
  return lines.join('\n')
}

/** Problems with the final caption on either platform, empty when it fits both. */
export function captionProblems(full: string): string[] {
  const problems: string[] = []
  if (charCount(full) > INSTAGRAM_CAPTION_LIMIT) {
    problems.push(`캡션이 Instagram 한도 ${INSTAGRAM_CAPTION_LIMIT}자를 넘어요`)
  }
  if (byteLength(youtubeSafe(full)) > YOUTUBE_DESCRIPTION_BYTES) {
    problems.push(`캡션이 YouTube 설명 한도 ${YOUTUBE_DESCRIPTION_BYTES}바이트를 넘어요`)
  }
  return problems
}

/** YouTube title: the script title, made safe and cut to the limit. */
export function youtubeTitle(title: string): string {
  return [...youtubeSafe(title.trim())].slice(0, YOUTUBE_TITLE_LIMIT).join('')
}

/** Validates one owner edit to a scene; returns an error message or null. */
export function sceneEditProblem(
  field: 'heading' | 'narration',
  text: string,
  scenes: Scene[],
  idx: number,
): string | null {
  if (!text.trim()) return '바꿀 내용이 비어 있어요.'
  if (idx < 1 || idx > scenes.length) {
    return `${idx}번 장면이 없어요. 이 원고는 장면 ${scenes.length}개예요.`
  }
  if (field === 'heading' && charCount(text) > LIMITS.heading) {
    return `화면 문구는 ${LIMITS.heading}자를 넘을 수 없어요: ${charCount(text)}자`
  }
  if (field === 'narration') {
    if (charCount(text) > LIMITS.sceneNarration) {
      return `장면 내레이션은 ${LIMITS.sceneNarration}자를 넘을 수 없어요: ${charCount(text)}자`
    }
    const next = scenes.map((s, i) => (i === idx - 1 ? { ...s, narration: text } : s))
    if (narrationLength(next) > LIMITS.narrationHard) {
      return `내레이션 합계가 ${LIMITS.narrationHard}자를 넘어요: ${narrationLength(next)}자`
    }
  }
  return null
}
