import { z } from 'zod'
import { config } from '../config.ts'
import { chatJson } from '../llm/openrouter.ts'
import { shortenScriptPrompt, VIDEO_PROMPT_VERSION, VIDEO_SCRIPT_SYSTEM } from './prompts.ts'
import { charCount, cleanHashtags, LIMITS, narrationLength, type Scene } from './types.ts'

// The video script: scenes written by the LLM from a published Threads post (docs/plans/video.md
// 3-4). Providers do not enforce maxLength reliably, so the schema accepts long text and the code
// fits it: the narration is shortened once, short fields are cut.

const sceneSchema = z.object({
  heading: z.string().min(1).max(200),
  narration: z.string().min(1).max(1000),
})
export const scriptSchema = z.object({
  title: z.string().min(1).max(400),
  caption: z.string().min(1).max(2000),
  hashtags: z.array(z.string()).max(20),
  scenes: z.array(sceneSchema).min(1).max(10),
})
const scenesOnlySchema = z.object({ scenes: z.array(sceneSchema).min(1).max(10) })

export type Script = {
  title: string
  caption: string
  hashtags: string[]
  scenes: Scene[]
}

export type StoredVideoGeneration = {
  model: string
  prompt_version: number
  feedback: string | null
}

export type ScriptSource = {
  postText: string
  followups: string[]
  topicTitle: string
  sourceLabel: string | null
  /** The script being regenerated, so feedback has something to refer to. */
  previous?: Script | null
  feedback?: string | null
}

type Chat = typeof chatJson

/** The user prompt: the published post (main + follow-ups), the topic and optional feedback. */
export function buildScriptPrompt(src: ScriptSource): string {
  const lines = [`주제: ${src.topicTitle}`]
  if (src.sourceLabel) lines.push(`출처: ${src.sourceLabel}`)
  lines.push('', '[Threads 글]', src.postText)
  src.followups.forEach((f, i) => {
    lines.push('', `[이어지는 답글 ${i + 1}]`, f)
  })
  if (src.previous && src.feedback) {
    lines.push('', '[이전 원고]', JSON.stringify(src.previous, null, 2))
  }
  if (src.feedback) lines.push('', `[작성자 피드백] 이 피드백을 반영해 다시 써라: ${src.feedback}`)
  return lines.join('\n')
}

const cut = (text: string, max: number) => {
  const t = text.trim()
  return charCount(t) <= max ? t : [...t].slice(0, max).join('').trim()
}

/** Trims fields and fits the short ones; returns problems that need the model or a retry. */
export function fitScript(raw: z.infer<typeof scriptSchema>): {
  script: Script
  problems: string[]
} {
  const scenes = raw.scenes
    .map((s) => ({
      heading: cut(s.heading.replace(/[.。]+$/, ''), LIMITS.heading),
      narration: s.narration.trim(),
    }))
    .filter((s) => s.heading && s.narration)
    .slice(0, LIMITS.maxScenes)
  const script: Script = {
    title: cut(raw.title, LIMITS.title),
    caption: cut(raw.caption, LIMITS.caption),
    hashtags: cleanHashtags(raw.hashtags),
    scenes,
  }
  const problems: string[] = []
  if (scenes.length < LIMITS.minScenes) {
    problems.push(`장면이 ${scenes.length}개로 ${LIMITS.minScenes}개보다 적어요`)
  }
  const total = narrationLength(scenes)
  if (total > LIMITS.narrationHard) {
    problems.push(`내레이션 합계 ${total}자가 ${LIMITS.narrationHard}자를 넘어요`)
  }
  return { script, problems }
}

/**
 * Writes a script. A narration over LIMITS.narrationMax is shortened once; anything still wrong
 * throws, so the job retries (a new sample usually fits).
 */
export async function writeScript(
  src: ScriptSource,
  opts: { model?: string; chat?: Chat } = {},
): Promise<{ script: Script; generation: StoredVideoGeneration }> {
  const model = opts.model ?? config.LLM_MODEL
  const chat = opts.chat ?? chatJson
  const raw = await chat({
    model,
    system: VIDEO_SCRIPT_SYSTEM,
    user: buildScriptPrompt(src),
    schema: scriptSchema,
    schemaName: 'video_script',
  })
  let { script } = fitScript(raw)
  if (narrationLength(script.scenes) > LIMITS.narrationMax) {
    const shorter = await chat({
      model,
      system: VIDEO_SCRIPT_SYSTEM,
      user: shortenScriptPrompt(
        JSON.stringify({ scenes: script.scenes }, null, 2),
        LIMITS.narrationMax - 20,
      ),
      schema: scenesOnlySchema,
      schemaName: 'video_script_shortened',
      temperature: 0.3,
    })
    script = fitScript({ ...raw, scenes: shorter.scenes }).script
  }
  const { problems } = fitScript(script)
  if (problems.length) throw new Error(`video script rejected: ${problems.join(', ')}`)
  return {
    script,
    generation: { model, prompt_version: VIDEO_PROMPT_VERSION, feedback: src.feedback ?? null },
  }
}

/** Text of the script message in Telegram and `video:show`; pure, shared by bot and CLI. */
export function formatScript(s: Script): string {
  const lines: string[] = [`제목: ${s.title}`, '']
  s.scenes.forEach((scene, i) => {
    lines.push(`[${i + 1}] ${scene.heading}`, scene.narration, '')
  })
  lines.push(`캡션: ${s.caption}`)
  if (s.hashtags.length) lines.push(s.hashtags.map((t) => `#${t}`).join(' '))
  return lines.join('\n')
}
