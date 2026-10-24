import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { getInstagramApi, getYouTubeApi, runYouTubeAuth } from './accounts.ts'
import { approveVideo, resetDryRun } from './approve.ts'
import { collectVideoInsights, videoReport } from './insights.ts'
import { loadBgm, runRender, runScript } from './pipeline.ts'
import { publishPublication, publishVideoNow } from './publish.ts'
import { renderVideo } from './render.ts'
import { formatScript, writeScript } from './script.ts'
import { createVideo, listVideos, loadPostScriptSource, loadVideo, restartVideo } from './store.ts'
import {
  approvedVideoText,
  formatVideoReview,
  sendManualUpload,
  sendVideoReview,
} from './telegram.ts'
import { configuredProviders, createTts, type TtsProviderName } from './tts.ts'
import { narrationLength } from './types.ts'
import { writeWav } from './wav.ts'

// Video commands of `npm run cli` (docs/operations.md). Kept here so src/cli.ts only dispatches.

export const VIDEO_USAGE = `
  video:tts-sample "<문장>" [provider...]  write one WAV per TTS provider with a key (to compare voices)
  video:script <postId>       write a video script for a published post and print it (read-only)
  video:render <postId>       script + render an mp4 into VIDEO_LOCAL_DIR/preview (no DB write)
  video:make <postId>         create (or restart) the post's video: script, render, Telegram review
  video:list                  list recent videos
  video:show <videoId>        print a video's review text and publications
  video:approve <videoId>     approve the video under review (next video slot)
  video:manual <videoId>      send the manual-upload caption and button again (no VIDEO_PLATFORMS)
  video:publish-now <videoId> publish the video's scheduled publications now
  video:reset-dry <videoId>   after turning VIDEO_PUBLISH_DRY_RUN off: schedule dry-run publications again
  video:insights              collect video insights now and print the report section
  instagram:check             verify the Instagram token (GET /me)
  youtube:auth                one-time YouTube OAuth (opens a local redirect listener)
  youtube:check               verify the YouTube account (channels.list mine)`

const num = (v: string | undefined, what: string) => {
  const n = Number(v?.replace(/^#/, ''))
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} is required`)
  return n
}

const previewDir = () => resolve(config.VIDEO_LOCAL_DIR, 'preview')

/** Runs a video command; false when `command` is not one. */
export async function runVideoCommand(
  command: string | undefined,
  args: string[],
): Promise<boolean> {
  switch (command) {
    case 'video:tts-sample': {
      const [text, ...names] = args
      if (!text) throw new Error('text is required')
      const providers = (names.length ? names : configuredProviders()) as TtsProviderName[]
      if (providers.length === 0) {
        throw new Error(
          'no TTS key is set (GOOGLE_TTS_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY)',
        )
      }
      const dir = resolve(config.VIDEO_LOCAL_DIR, 'samples')
      await mkdir(dir, { recursive: true })
      for (const name of providers) {
        const tts = createTts(name)
        const file = join(dir, `${name}-${tts.voiceId.replace(/[^\w.-]/g, '_')}.wav`)
        await writeFile(file, writeWav(await tts.synthesize(text)))
        console.log(file)
      }
      return true
    }
    case 'video:script': {
      const postId = num(args[0], 'postId')
      const src = await loadPostScriptSource(postId)
      if (!src) throw new Error(`post ${postId} not found`)
      const { script } = await writeScript(src)
      console.log(formatScript(script))
      console.log(`\n내레이션 ${narrationLength(script.scenes)}자 · 장면 ${script.scenes.length}개`)
      return true
    }
    case 'video:render': {
      const postId = num(args[0], 'postId')
      const src = await loadPostScriptSource(postId)
      if (!src) throw new Error(`post ${postId} not found`)
      const { script } = await writeScript(src)
      console.log(formatScript(script))
      const bgm = await loadBgm()
      const result = await renderVideo(
        { scenes: script.scenes, sourceLabel: src.sourceLabel, brand: config.VIDEO_BRAND ?? null },
        createTts(),
        { bgmPath: bgm?.path ?? null },
      )
      try {
        await mkdir(previewDir(), { recursive: true })
        const out = join(previewDir(), `post-${postId}.mp4`)
        await copyFile(result.path, out)
        console.log(
          `\n${out} · ${(result.durationMs / 1000).toFixed(1)}초 · ${result.sizeBytes} bytes`,
        )
      } finally {
        await result.cleanup()
      }
      return true
    }
    case 'video:make': {
      const postId = num(args[0], 'postId')
      const created = await createVideo(postId)
      if ('notEligible' in created) throw new Error(created.notEligible)
      const videoId = 'created' in created ? created.created : created.exists
      const seq = 'created' in created ? 1 : await restartVideo(videoId)
      if (seq === null) {
        console.log(`video #${videoId} already exists (${(await loadVideo(videoId))?.status})`)
        return true
      }
      if (!(await runScript(videoId, seq))) throw new Error('script was not applied')
      const outcome = await runRender(videoId)
      console.log(`video #${videoId}: render ${outcome.kind}`)
      if (outcome.kind === 'rendered' || outcome.kind === 'unchanged')
        await sendVideoReview(videoId)
      return true
    }
    case 'video:list':
      console.table(await listVideos(30))
      return true
    case 'video:show': {
      const v = await loadVideo(num(args[0], 'videoId'))
      if (!v) throw new Error('video not found')
      console.log(`[${v.status}] ${v.video_url ?? '(no file)'}\n${formatVideoReview(v)}\n`)
      console.table(
        await query(
          `select id, platform, status, scheduled_at, attempts, platform_media_id, last_error
           from video_publications where video_id = $1 order by id`,
          [v.id],
        ),
      )
      return true
    }
    case 'video:approve': {
      const v = await loadVideo(num(args[0], 'videoId'))
      if (!v) throw new Error('video not found')
      const approval = await approveVideo(v.id, { revision: v.revision })
      console.log(approvedVideoText(v.id, approval))
      if (!approval.at) await sendManualUpload(v.id)
      return true
    }
    case 'video:manual': {
      const sent = await sendManualUpload(num(args[0], 'videoId'))
      console.log(sent ? 'sent' : 'not an APPROVED video without automatic publications')
      return true
    }
    case 'video:publish-now': {
      const videoId = num(args[0], 'videoId')
      await publishVideoNow(videoId)
      const pubs = await query<{ id: number }>(
        "select id from video_publications where video_id = $1 and status = 'SCHEDULED' order by id",
        [videoId],
      )
      if (pubs.length === 0) console.log('nothing scheduled')
      for (const p of pubs) console.log(p.id, await publishPublication(p.id))
      return true
    }
    case 'video:reset-dry': {
      const at = await resetDryRun(num(args[0], 'videoId'))
      console.log(at ? `scheduled again at ${at.toISOString()}` : 'no dry-run publications')
      return true
    }
    case 'video:insights':
      console.log(await collectVideoInsights())
      console.log((await videoReport()).join('\n') || '최근 7일에 발행한 영상이 없어요.')
      return true
    case 'instagram:check':
      console.log(await (await getInstagramApi()).me())
      return true
    case 'youtube:auth':
      console.log('saved:', (await runYouTubeAuth(console.log)).channel)
      return true
    case 'youtube:check':
      console.log(await (await getYouTubeApi()).channel())
      return true
    default:
      return false
  }
}
