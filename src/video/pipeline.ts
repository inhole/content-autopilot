import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { config } from '../config.ts'
import { type Bgm, RenderLimitError, renderInputHash, renderVideo } from './render.ts'
import { writeScript } from './script.ts'
import { getStorage, storageKey, type VideoStorage } from './storage.ts'
import {
  applyRender,
  applyScript,
  failStage,
  loadRenderJob,
  loadScriptSource,
  skipRender,
} from './store.ts'
import { createTts, type TtsProvider } from './tts.ts'

// The script and render stages (docs/plans/video.md 3-5). Each one writes its result only while
// it still owns the stage, so a stale or duplicate job changes nothing.

export async function loadBgm(path = config.VIDEO_BGM_PATH): Promise<Bgm> {
  if (!path) return null
  const { size } = await stat(path)
  return { path, size }
}

/** Writes the script for request `seq`. False when the request is no longer the latest. */
export async function runScript(
  videoId: number,
  seq: number,
  deps: { write?: typeof writeScript } = {},
): Promise<boolean> {
  const src = await loadScriptSource(videoId)
  if (!src || src.seq !== seq) return false
  const { script, generation } = await (deps.write ?? writeScript)(src)
  return applyScript(videoId, seq, script, generation)
}

export type RenderOutcome =
  | { kind: 'rendered' }
  | { kind: 'unchanged' }
  | { kind: 'stale' }
  | { kind: 'failed'; error: string }

/**
 * Renders the current scenes, uploads the file and moves the video to review. A render whose
 * script changed meanwhile deletes its own upload. A RenderLimitError fails the video (rendering
 * the same script again would not help); other errors throw so the job retries.
 */
export async function runRender(
  videoId: number,
  deps: {
    tts?: TtsProvider
    storage?: VideoStorage
    render?: typeof renderVideo
    bgm?: Bgm
  } = {},
): Promise<RenderOutcome> {
  const job = await loadRenderJob(videoId)
  if (!job) return { kind: 'stale' }
  const tts = deps.tts ?? createTts()
  const bgm = deps.bgm !== undefined ? deps.bgm : await loadBgm()
  const input = {
    scenes: job.scenes,
    sourceLabel: job.source_label,
    brand: config.VIDEO_BRAND ?? null,
  }
  const hash = renderInputHash(input, tts, bgm)
  if (job.render_hash === hash && (await skipRender(videoId, job.revision, hash))) {
    return { kind: 'unchanged' }
  }

  let result: Awaited<ReturnType<typeof renderVideo>>
  try {
    result = await (deps.render ?? renderVideo)(input, tts, { bgmPath: bgm?.path ?? null })
  } catch (err) {
    if (err instanceof RenderLimitError) {
      await failStage(videoId, 'RENDERING', err.message)
      return { kind: 'failed', error: err.message }
    }
    throw err
  }

  const storage = deps.storage ?? getStorage()
  try {
    const key = storageKey(videoId, randomUUID().slice(0, 8), result.sha256)
    const url = await storage.upload(result.path, key)
    const applied = await applyRender(videoId, job.revision, {
      hash,
      url,
      key,
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
    })
    // Only this run's key, or the file this render replaced, is ever deleted.
    const orphan = applied.applied ? applied.previousKey : key
    if (orphan) {
      await storage
        .remove(orphan)
        .catch((err: unknown) =>
          console.warn(`[video-render] could not delete ${orphan}`, (err as Error).message),
        )
    }
    return applied.applied ? { kind: 'rendered' } : { kind: 'stale' }
  } finally {
    await result.cleanup()
  }
}
