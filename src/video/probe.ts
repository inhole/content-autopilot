import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { runFfmpeg } from './render.ts'

// Checks an uploaded file before it goes anywhere (docs/plans/video-upload.md 5). The file is
// untrusted: ffprobe and ffmpeg only ever open the server's own temp path, through the `file`
// protocol only, with the MP4/MOV demuxer forced (no format guessing, no playlists), under a time
// limit and an output cap. The rules are the intersection of the Instagram Reels API and Shorts.

export const PROBE_TIMEOUT_MS = 30_000
export const REMUX_TIMEOUT_MS = 120_000
const PROBE_MAX_OUTPUT = 1024 * 1024

export const UPLOAD_RULES = {
  minMs: 3_000,
  maxMs: 180_000,
  maxWidth: 1920,
  minShortSide: 540,
  minFps: 23,
  maxFps: 60,
  maxVideoBps: 25_000_000,
  maxSampleRate: 48_000,
  maxChannels: 2,
  maxAudioBps: 128_000,
} as const

/** The file breaks a rule; `message` is shown to the owner as is. */
export class UploadRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRejected'
  }
}

type SideData = { side_data_type?: string; rotation?: number | string }

export type ProbeStream = {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  field_order?: string
  sample_aspect_ratio?: string
  avg_frame_rate?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  disposition?: { attached_pic?: number }
  tags?: { rotate?: string }
  side_data_list?: SideData[]
}

export type ProbeOutput = {
  format?: {
    format_name?: string
    duration?: string
    tags?: { major_brand?: string }
  }
  streams?: ProbeStream[]
}

export type UploadInfo = {
  durationMs: number
  /** Display size: the coded size with the rotation applied. */
  width: number
  height: number
  container: 'mp4' | 'mov'
  videoCodec: 'h264' | 'hevc'
  hasAudio: boolean
  /** ffprobe stream indexes of the checked streams: what the remux keeps. */
  videoIndex: number
  audioIndex: number | null
}

const finite = (n: number) => Number.isFinite(n) && n > 0

/** `30000/1001` → 29.97; NaN for anything else (a zero denominator included). */
export function parseRate(rate: string | undefined): number {
  const m = /^(\d+)\/(\d+)$/.exec(rate ?? '')
  if (!m) return Number.NaN
  const den = Number(m[2])
  return den === 0 ? Number.NaN : Number(m[1]) / den
}

/** Degrees the player rotates the picture: the display matrix, else the legacy `rotate` tag. */
export function rotationOf(s: ProbeStream): number {
  const matrix = s.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')
  const raw = matrix?.rotation ?? s.tags?.rotate
  const deg = Number(raw ?? 0)
  return Number.isFinite(deg) ? deg : 0
}

/** Applies the rules to ffprobe's JSON. Throws UploadRejected with the first broken rule. */
export function checkUpload(probe: ProbeOutput, sizeBytes: number): UploadInfo {
  const R = UPLOAD_RULES
  const fmt = probe.format ?? {}
  if (!/(^|,)(mov|mp4)(,|$)/.test(fmt.format_name ?? '')) {
    throw new UploadRejected('mp4나 mov 파일만 올릴 수 있어요')
  }
  const streams = probe.streams ?? []
  const videos = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audios = streams.filter((s) => s.codec_type === 'audio')
  if (videos.length !== 1) throw new UploadRejected('영상 트랙이 하나여야 해요')
  if (audios.length > 1) throw new UploadRejected('소리 트랙은 하나까지만 돼요')
  const v = videos[0] as ProbeStream

  const codec = v.codec_name
  if (codec !== 'h264' && codec !== 'hevc') {
    throw new UploadRejected('H.264나 HEVC로 내보내 주세요')
  }
  if (v.pix_fmt !== 'yuv420p' && v.pix_fmt !== 'yuvj420p') {
    throw new UploadRejected('색 형식은 4:2:0(yuv420p)이어야 해요')
  }
  if (v.field_order && v.field_order !== 'progressive' && v.field_order !== 'unknown') {
    throw new UploadRejected('인터레이스 영상은 올릴 수 없어요')
  }
  const sar = v.sample_aspect_ratio
  if (sar && sar !== '1:1' && sar !== '0:1' && sar !== 'N/A') {
    throw new UploadRejected('픽셀 비율이 1:1이어야 해요')
  }

  const coded = { w: v.width ?? 0, h: v.height ?? 0 }
  if (!finite(coded.w) || !finite(coded.h)) throw new UploadRejected('해상도를 읽지 못했어요')
  const turned = Math.abs(rotationOf(v)) % 180 === 90
  const width = turned ? coded.h : coded.w
  const height = turned ? coded.w : coded.h
  if (height < width) throw new UploadRejected('세로 영상만 올릴 수 있어요')
  if (width > R.maxWidth || height > R.maxWidth * 2) {
    throw new UploadRejected('1080p 이하로 내보내 주세요')
  }
  if (width < R.minShortSide) throw new UploadRejected('해상도가 너무 낮아요 (가로 540px 이상)')

  const fps = parseRate(v.avg_frame_rate)
  if (!Number.isFinite(fps) || fps < R.minFps || fps > R.maxFps + 0.5) {
    throw new UploadRejected('프레임 수가 23~60fps여야 해요')
  }

  const durationS = Number(fmt.duration)
  if (!finite(durationS)) throw new UploadRejected('영상 길이를 읽지 못했어요')
  const durationMs = Math.round(durationS * 1000)
  if (durationMs < R.minMs || durationMs > R.maxMs) {
    throw new UploadRejected('3초~3분 영상만 올릴 수 있어요')
  }

  // The stream's own rate when the container says it, else the whole file's (an upper bound).
  const streamBps = Number(v.bit_rate)
  const bps = finite(streamBps) ? streamBps : (sizeBytes * 8) / durationS
  if (bps > R.maxVideoBps) throw new UploadRejected('비트레이트가 너무 높아요 (25Mbps 이하)')

  const a = audios[0]
  if (a) {
    const rate = Number(a.sample_rate)
    const channels = a.channels ?? 0
    // Without a stated audio rate there is nothing to compare; the video check above already
    // bounds the whole file.
    const audioBps = Number(a.bit_rate)
    if (
      a.codec_name !== 'aac' ||
      !finite(rate) ||
      rate > R.maxSampleRate ||
      channels < 1 ||
      channels > R.maxChannels ||
      (finite(audioBps) && audioBps > R.maxAudioBps * 1.05)
    ) {
      throw new UploadRejected('소리는 AAC 48kHz·128kbps 이하, 모노나 스테레오여야 해요')
    }
  }

  const brand = fmt.tags?.major_brand?.trim()
  return {
    durationMs,
    width,
    height,
    container: brand === 'qt' ? 'mov' : 'mp4',
    videoCodec: codec,
    hasAudio: Boolean(a),
    videoIndex: v.index ?? 0,
    audioIndex: a ? (a.index ?? null) : null,
  }
}

/** Input options shared by ffprobe and the remux: local files only, MP4/MOV demuxer only. */
const SAFE_INPUT = ['-protocol_whitelist', 'file', '-f', 'mov']

/** Runs ffprobe on a local file and returns its JSON. Throws UploadRejected if unreadable. */
export function runProbe(file: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutput> {
  const args = [
    '-v',
    'error',
    ...SAFE_INPUT,
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    `file:${file}`,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeInstaller.path, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('ffprobe timed out')), timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > PROBE_MAX_OUTPUT) fail(new UploadRejected('영상 파일 구조가 너무 복잡해요'))
      else chunks.push(d)
    })
    child.stderr.resume()
    child.on('error', fail)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new UploadRejected('영상 파일을 읽지 못했어요 (손상됐거나 mp4/mov가 아니에요)'))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProbeOutput)
      } catch {
        reject(new UploadRejected('영상 파일을 읽지 못했어요'))
      }
    })
  })
}

/**
 * Re-wraps the checked file as MP4 without re-encoding: exactly the checked video and audio
 * streams (by index, so cover art in front is skipped), no metadata, the index (moov) up front and
 * no edit lists (Reels refuses them). The display rotation stays as stream side data.
 */
export async function remuxToMp4(input: string, output: string, info: UploadInfo): Promise<void> {
  await runFfmpeg(
    [
      '-hide_banner',
      '-v',
      'error',
      ...SAFE_INPUT,
      '-i',
      `file:${input}`,
      '-map',
      `0:${info.videoIndex}`,
      ...(info.audioIndex === null ? [] : ['-map', `0:${info.audioIndex}`]),
      '-c',
      'copy',
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      '-use_editlist',
      '0',
      ...(info.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-f',
      'mp4',
      '-y',
      `file:${output}`,
    ],
    REMUX_TIMEOUT_MS,
  )
}

export type Mp4Layout = { moovBeforeMdat: boolean; editLists: number }

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'])
const MAX_MOOV = 16 * 1024 * 1024

/** Walks boxes in `buf`, counting `edts` (edit list containers) at any depth. */
function countEditLists(buf: Buffer, start: number, end: number): number {
  let n = 0
  let at = start
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1 && at + 16 <= end) {
      size = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header || at + size > end) break
    if (type === 'edts') n++
    if (CONTAINERS.has(type)) n += countEditLists(buf, at + header, at + size)
    at += size
  }
  return n
}

/**
 * Reads the top-level boxes of an MP4 (headers only, plus the moov box): whether the index comes
 * before the media data (fast start) and how many edit lists the tracks carry.
 */
export async function mp4Layout(file: string): Promise<Mp4Layout> {
  const fh = await open(file, 'r')
  try {
    const { size: total } = await fh.stat()
    const head = Buffer.alloc(16)
    let at = 0
    let mdatAt = -1
    let moov: Buffer | null = null
    let moovAt = -1
    while (at + 8 <= total) {
      await fh.read(head, 0, 16, at)
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (size === 1) size = Number(head.readBigUInt64BE(8))
      else if (size === 0) size = total - at
      if (size < 8) break
      if (type === 'mdat' && mdatAt < 0) mdatAt = at
      if (type === 'moov' && !moov) {
        if (size > MAX_MOOV) throw new UploadRejected('영상 파일 구조가 너무 복잡해요')
        moov = Buffer.alloc(size)
        await fh.read(moov, 0, size, at)
        moovAt = at
      }
      at += size
    }
    if (!moov) throw new UploadRejected('영상 파일을 읽지 못했어요')
    return {
      moovBeforeMdat: mdatAt < 0 || moovAt < mdatAt,
      editLists: countEditLists(moov, 8, moov.length),
    }
  } finally {
    await fh.close()
  }
}

/**
 * Probes, checks, remuxes and checks the result again (same rules, length and display size, the
 * index up front, no edit lists), so what is stored is exactly what was checked.
 */
export async function prepareUpload(
  input: string,
  output: string,
  sizeBytes: number,
): Promise<UploadInfo> {
  const info = checkUpload(await runProbe(input), sizeBytes)
  await remuxToMp4(input, output, info)
  const after = checkUpload(await runProbe(output), sizeBytes)
  const layout = await mp4Layout(output)
  if (!layout.moovBeforeMdat || layout.editLists > 0) {
    throw new UploadRejected('mp4로 다시 묶지 못했어요. 편집 앱에서 다시 내보내 주세요')
  }
  if (
    after.width !== info.width ||
    after.height !== info.height ||
    Math.abs(after.durationMs - info.durationMs) > 500
  ) {
    throw new UploadRejected('mp4로 다시 묶는 중에 영상이 달라졌어요')
  }
  return { ...after, container: info.container }
}
