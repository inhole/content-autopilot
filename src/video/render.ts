import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { renderFrame, TEMPLATE_VERSION } from './frames.ts'
import { type AudioPiece, buildTimeline, splitSentences, type Timeline } from './subtitles.ts'
import type { TtsProvider } from './tts.ts'
import type { Scene } from './types.ts'
import { pcmDurationMs, silence, writeWav } from './wav.ts'

// Timeline → narration WAV + frame PNGs → H.264/AAC mp4 (docs/plans/video.md 3-2).

export const FPS = 30
const FFMPEG_TIMEOUT_MS = 5 * 60_000
/** Final checks: Telegram uploads stop at 50MB; Reels/Shorts targets are 30-45s. */
export const RENDER_LIMITS = { minMs: 15_000, maxMs: 75_000, maxBytes: 45 * 1024 * 1024 }
const DURATION_TOLERANCE_MS = 1_000

/** The video breaks a hard limit; rendering again gives the same result, so do not retry. */
export class RenderLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderLimitError'
  }
}

export type RenderInput = {
  scenes: Scene[]
  sourceLabel: string | null
  brand: string | null
}

export type Bgm = { path: string; size: number } | null

/**
 * Hash of everything that changes the output: scenes, labels, voice, template (fonts included)
 * and background music. Same hash, same video: an unchanged script is not rendered twice.
 */
export function renderInputHash(input: RenderInput, tts: TtsProvider, bgm: Bgm): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        template: TEMPLATE_VERSION,
        scenes: input.scenes.map((s) => [s.heading, s.narration]),
        source: input.sourceLabel,
        brand: input.brand,
        tts: [tts.name, tts.voiceId],
        bgm: bgm ? [bgm.path, bgm.size] : null,
      }),
    )
    .digest('hex')
}

export type RenderResult = {
  /** The mp4 inside `dir`; the caller uploads it and then calls `cleanup`. */
  path: string
  dir: string
  durationMs: number
  sizeBytes: number
  sha256: string
  timeline: Timeline
  cleanup: () => Promise<void>
}

/** ffmpeg's concat demuxer list: each frame with its duration, the last one repeated. */
export function concatList(files: string[], durationsMs: number[]): string {
  const lines: string[] = []
  files.forEach((f, i) => {
    lines.push(`file '${f}'`, `duration ${((durationsMs[i] ?? 0) / 1000).toFixed(3)}`)
  })
  const last = files[files.length - 1]
  if (last) lines.push(`file '${last}'`)
  return `${lines.join('\n')}\n`
}

export function ffmpegArgs(opts: {
  list: string
  narration: string
  bgm: string | null
  totalMs: number
  out: string
}): string[] {
  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', opts.list]
  args.push('-i', opts.narration)
  const video = `[0:v]fps=${FPS},format=yuv420p[v]`
  if (opts.bgm) {
    args.push('-stream_loop', '-1', '-i', opts.bgm)
    args.push(
      '-filter_complex',
      `${video};[2:a]volume=-22dB[b];[1:a][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
    )
  } else {
    args.push('-filter_complex', video, '-map', '[v]', '-map', '1:a')
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-crf',
    '20',
    '-r',
    String(FPS),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    (opts.totalMs / 1000).toFixed(3),
    '-threads',
    '2',
    '-movflags',
    '+faststart',
    opts.out,
  )
  return args
}

function ffmpegBin(): string {
  const bin = ffmpegPath as unknown as string | null
  if (!bin) throw new Error('ffmpeg-static has no binary for this platform')
  return bin
}

/** Runs ffmpeg as a child process with a time limit; resolves with stderr. */
export function runFfmpeg(args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20_000) stderr += d.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

/** Duration from `ffmpeg -i` output (`Duration: 00:00:38.52`), in ms; null if missing. */
export function parseDurationMs(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000)
}

async function probeDurationMs(file: string): Promise<number | null> {
  // `ffmpeg -i` without an output exits 1 but prints the input's duration.
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-i', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let out = ''
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })
  return parseDurationMs(stderr)
}

/** Synthesizes every sentence (in order, one request at a time). */
async function synthesize(scenes: Scene[], tts: TtsProvider): Promise<Buffer[][]> {
  const out: Buffer[][] = []
  for (const scene of scenes) {
    const pcms: Buffer[] = []
    for (const sentence of splitSentences(scene.narration))
      pcms.push(await tts.synthesize(sentence))
    out.push(pcms)
  }
  return out
}

export function assembleNarration(audio: AudioPiece[], speech: Buffer[][]): Buffer {
  return Buffer.concat(
    audio.map((p) => {
      if (p.kind === 'silence') return silence(p.ms)
      const pcm = speech[p.scene]?.[p.sentence]
      if (!pcm) throw new Error(`missing speech for scene ${p.scene} sentence ${p.sentence}`)
      return pcm
    }),
  )
}

/**
 * Renders the video into a fresh temp folder. Checks the result (duration against the timeline,
 * length and size limits) before returning; a RenderLimitError means the script itself is wrong.
 */
export async function renderVideo(
  input: RenderInput,
  tts: TtsProvider,
  opts: { bgmPath?: string | null; limits?: typeof RENDER_LIMITS } = {},
): Promise<RenderResult> {
  const limits = opts.limits ?? RENDER_LIMITS
  const dir = join(tmpdir(), 'content-autopilot', `render-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const speech = await synthesize(input.scenes, tts)
    const timeline = buildTimeline(
      input.scenes,
      speech.map((pcms) => pcms.map(pcmDurationMs)),
    )
    if (timeline.totalMs > limits.maxMs) {
      throw new RenderLimitError(
        `영상이 ${Math.round(timeline.totalMs / 1000)}초로 ${limits.maxMs / 1000}초를 넘어요`,
      )
    }
    if (timeline.totalMs < limits.minMs) {
      throw new RenderLimitError(
        `영상이 ${Math.round(timeline.totalMs / 1000)}초로 ${limits.minMs / 1000}초보다 짧아요`,
      )
    }
    const narration = join(dir, 'narration.wav')
    await writeFile(narration, writeWav(assembleNarration(timeline.audio, speech)))

    const files: string[] = []
    for (const [i, cue] of timeline.cues.entries()) {
      const name = `f${String(i).padStart(3, '0')}.png`
      const png = await renderFrame({
        scenes: input.scenes,
        scene: cue.scene,
        subtitle: cue.subtitle,
        brand: input.brand,
        sourceLabel: input.sourceLabel,
      })
      await writeFile(join(dir, name), png)
      files.push(name)
    }
    const list = join(dir, 'frames.txt')
    await writeFile(
      list,
      concatList(
        files,
        timeline.cues.map((c) => c.durationMs),
      ),
    )

    const out = join(dir, 'video.mp4')
    await runFfmpeg(
      ffmpegArgs({
        list,
        narration,
        bgm: opts.bgmPath ?? null,
        totalMs: timeline.totalMs,
        out,
      }),
    )
    const probed = await probeDurationMs(out)
    if (probed === null) throw new Error('could not read the rendered video duration')
    if (Math.abs(probed - timeline.totalMs) > DURATION_TOLERANCE_MS) {
      throw new Error(`rendered ${probed}ms but the timeline is ${timeline.totalMs}ms`)
    }
    const { size } = await stat(out)
    if (size > limits.maxBytes) {
      throw new RenderLimitError(`영상 파일이 ${Math.round(size / 1024 / 1024)}MB로 너무 커요`)
    }
    const sha256 = createHash('sha256')
      .update(await readFile(out))
      .digest('hex')
    return { path: out, dir, durationMs: probed, sizeBytes: size, sha256, timeline, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
