import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import {
  checkUpload,
  mp4Layout,
  type ProbeOutput,
  type ProbeStream,
  parseRate,
  prepareUpload,
  rotationOf,
  UploadRejected,
} from '../src/video/probe.ts'
import { runFfmpeg } from '../src/video/render.ts'

const video = (over: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 1080,
  height: 1920,
  pix_fmt: 'yuv420p',
  field_order: 'progressive',
  sample_aspect_ratio: '1:1',
  avg_frame_rate: '30/1',
  bit_rate: '8000000',
  ...over,
})
const audio = (over: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  sample_rate: '48000',
  channels: 2,
  ...over,
})
const probe = (streams: ProbeStream[], format: ProbeOutput['format'] = {}): ProbeOutput => ({
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '30.0',
    tags: { major_brand: 'isom' },
    ...format,
  },
  streams,
})
const MB = 1024 * 1024
const reason = (p: ProbeOutput, size = 10 * MB) => {
  try {
    checkUpload(p, size)
    return 'ok'
  } catch (err) {
    expect(err).toBeInstanceOf(UploadRejected)
    return (err as Error).message
  }
}

describe('checkUpload', () => {
  it('accepts a portrait H.264/AAC mp4 and reports its display size', () => {
    expect(checkUpload(probe([video(), audio()]), 10 * MB)).toEqual({
      durationMs: 30_000,
      width: 1080,
      height: 1920,
      container: 'mp4',
      videoCodec: 'h264',
      hasAudio: true,
      videoIndex: 0,
      audioIndex: 1,
    })
  })

  it('applies the display rotation of phone videos', () => {
    const turned = video({
      width: 1920,
      height: 1080,
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    })
    expect(checkUpload(probe([turned]), MB)).toMatchObject({ width: 1080, height: 1920 })
    expect(rotationOf(video({ tags: { rotate: '90' } }))).toBe(90)
    expect(reason(probe([video({ width: 1920, height: 1080 })]))).toBe('세로 영상만 올릴 수 있어요')
  })

  it('tells MOV from MP4 by the brand and ignores cover art', () => {
    const cover = video({ index: 0, codec_name: 'mjpeg', disposition: { attached_pic: 1 } })
    const info = checkUpload(
      probe([cover, video({ index: 1 }), audio({ index: 2 })], { tags: { major_brand: 'qt  ' } }),
      MB,
    )
    expect(info).toMatchObject({ container: 'mov', videoIndex: 1, audioIndex: 2 })
    expect(reason(probe([video(), video()]))).toBe('영상 트랙이 하나여야 해요')
    expect(reason(probe([video(), audio(), audio()]))).toBe('소리 트랙은 하나까지만 돼요')
    expect(reason(probe([audio()]))).toBe('영상 트랙이 하나여야 해요')
  })

  it('rejects what Reels cannot take', () => {
    expect(reason(probe([video()], { format_name: 'matroska,webm' }))).toMatch(/mp4나 mov/)
    expect(reason(probe([video({ codec_name: 'vp9' })]))).toMatch(/H.264나 HEVC/)
    expect(reason(probe([video({ pix_fmt: 'yuv422p' })]))).toMatch(/4:2:0/)
    expect(reason(probe([video({ field_order: 'tt' })]))).toMatch(/인터레이스/)
    expect(reason(probe([video({ sample_aspect_ratio: '4:3' })]))).toMatch(/픽셀 비율/)
    expect(reason(probe([video({ width: 2160, height: 3840 })]))).toMatch(/1080p 이하/)
    expect(reason(probe([video({ width: 360, height: 640 })]))).toMatch(/해상도가 너무 낮아요/)
    expect(reason(probe([video({ avg_frame_rate: '120/1' })]))).toMatch(/23~60fps/)
    expect(reason(probe([video({ avg_frame_rate: '0/0' })]))).toMatch(/23~60fps/)
    expect(reason(probe([video({ bit_rate: '40000000' })]))).toMatch(/비트레이트/)
    expect(reason(probe([video(), audio({ codec_name: 'opus' })]))).toMatch(/AAC/)
    expect(reason(probe([video(), audio({ sample_rate: '96000' })]))).toMatch(/AAC/)
    expect(reason(probe([video(), audio({ channels: 6 })]))).toMatch(/AAC/)
    expect(reason(probe([video(), audio({ bit_rate: '256000' })]))).toMatch(/128kbps/)
    expect(reason(probe([video(), audio({ bit_rate: '128000' })]))).toBe('ok')
  })

  it('bounds the length and falls back to the file bitrate', () => {
    expect(reason(probe([video()], { duration: '2.5' }))).toMatch(/3초~3분/)
    expect(reason(probe([video()], { duration: '181' }))).toMatch(/3초~3분/)
    expect(reason(probe([video()], { duration: 'N/A' }))).toMatch(/길이/)
    // 50MB over 10s = 42Mbps.
    expect(reason(probe([video({ bit_rate: undefined })], { duration: '10' }), 50 * MB)).toMatch(
      /비트레이트/,
    )
    expect(checkUpload(probe([video({ avg_frame_rate: '30000/1001' })]), MB).durationMs).toBe(
      30_000,
    )
  })

  it('parses frame rates', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRate('25/0')).toBeNaN()
    expect(parseRate(undefined)).toBeNaN()
  })
})

describe.skipIf(!ffmpegPath)('prepareUpload (ffmpeg/ffprobe smoke)', () => {
  const make = async (dir: string, name: string, args: string[]) => {
    const file = join(dir, name)
    await runFfmpeg(['-v', 'error', '-y', ...args, file])
    return file
  }

  it('checks and remuxes portrait, rotated and MOV files and rejects landscape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-probe-'))
    try {
      const portrait = await make(dir, 'portrait.mp4', [
        ...['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
        ...['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2'],
      ])
      const landscape = await make(dir, 'landscape.mp4', [
        ...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'],
        ...['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      ])
      const rotated = await make(dir, 'rotated.mp4', [
        ...['-display_rotation', '90', '-i', landscape, '-c', 'copy'],
      ])
      const mov = await make(dir, 'portrait.mov', ['-i', portrait, '-c', 'copy', '-f', 'mov'])
      const png = await make(dir, 'cover.png', [
        ...['-f', 'lavfi', '-i', 'color=red:size=200x200', '-frames:v', '1'],
      ])
      // Cover art as the first stream: the remux must keep the real video, not the picture.
      const covered = await make(dir, 'covered.mp4', [
        ...['-i', png, '-i', portrait, '-map', '0', '-map', '1', '-c', 'copy'],
        ...['-disposition:v:0', 'attached_pic'],
      ])
      // libx264 B-frames and AAC priming make ffmpeg write edit lists by default.
      expect((await mp4Layout(portrait)).editLists).toBeGreaterThan(0)

      const run = async (file: string) =>
        prepareUpload(file, `${file}.out.mp4`, (await stat(file)).size)
      expect(await run(portrait)).toMatchObject({ width: 1080, height: 1920, hasAudio: true })
      expect(await mp4Layout(`${portrait}.out.mp4`)).toEqual({ moovBeforeMdat: true, editLists: 0 })
      expect(await run(covered)).toMatchObject({ width: 1080, height: 1920, hasAudio: true })
      const fromMov = await run(mov)
      expect(fromMov.container).toBe('mov')
      // Without edit lists the B-frame delay shows up in the length (about 2 frames).
      expect(Math.abs(fromMov.durationMs - 4000)).toBeLessThan(200)
      // The rotation survives the remux (checked again on the output).
      expect(await run(rotated)).toMatchObject({ width: 1080, height: 1920, hasAudio: false })
      await expect(run(landscape)).rejects.toThrow('세로 영상만 올릴 수 있어요')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('rejects a file that is not a video at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-probe-'))
    try {
      const fake = join(dir, 'fake.mp4')
      await import('node:fs/promises').then((fs) => fs.writeFile(fake, '#EXTM3U\nhttp://x/a.ts\n'))
      await expect(prepareUpload(fake, `${fake}.out`, 30)).rejects.toBeInstanceOf(UploadRejected)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
