import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.ts'
import {
  concatList,
  ffmpegArgs,
  parseDurationMs,
  RenderLimitError,
  renderInputHash,
  renderVideo,
} from '../src/video/render.ts'
import { isDuplicate, LocalStorage, SupabaseStorage, storageKey } from '../src/video/storage.ts'
import {
  configuredProviders,
  createTts,
  ElevenLabsTts,
  GoogleTts,
  OpenAiTts,
  SilentTts,
  type TtsProvider,
} from '../src/video/tts.ts'
import { pcmDurationMs, silence, writeWav } from '../src/video/wav.ts'

const input = {
  scenes: [
    { heading: '훅 문구', narration: '첫 문장이야. 둘째 문장이야.' },
    { heading: '본문', narration: '셋째 문장이야.' },
  ],
  sourceLabel: 'example.com',
  brand: '@me',
}

describe('render helpers', () => {
  it('writes the concat list with the last frame repeated', () => {
    expect(concatList(['a.png', 'b.png'], [1500, 2250])).toBe(
      "file 'a.png'\nduration 1.500\nfile 'b.png'\nduration 2.250\nfile 'b.png'\n",
    )
  })

  it('maps narration only, or mixes background music under it', () => {
    const plain = ffmpegArgs({
      list: 'l',
      narration: 'n.wav',
      bgm: null,
      totalMs: 30_000,
      out: 'o.mp4',
    })
    expect(plain).toContain('1:a')
    expect(plain.join(' ')).toContain('-t 30.000')
    const mixed = ffmpegArgs({
      list: 'l',
      narration: 'n.wav',
      bgm: 'm.mp3',
      totalMs: 1000,
      out: 'o.mp4',
    })
    expect(mixed.join(' ')).toMatch(/-stream_loop -1 -i m\.mp3/)
    expect(mixed.join(' ')).toContain('amix=inputs=2:duration=first')
  })

  it('parses the duration ffmpeg prints', () => {
    expect(parseDurationMs('  Duration: 00:00:38.52, start: 0')).toBe(38_520)
    expect(parseDurationMs('nothing')).toBeNull()
  })

  it('changes the render hash with the voice, scenes or music, not otherwise', () => {
    const a: TtsProvider = {
      name: 'google',
      voiceId: 'v1',
      synthesize: async () => Buffer.alloc(0),
    }
    const b: TtsProvider = { ...a, voiceId: 'v2' }
    const h = renderInputHash(input, a, null)
    expect(renderInputHash(input, a, null)).toBe(h)
    expect(renderInputHash(input, b, null)).not.toBe(h)
    expect(renderInputHash(input, a, { path: 'm.mp3', size: 1 })).not.toBe(h)
    expect(renderInputHash({ ...input, brand: '@other' }, a, null)).not.toBe(h)
  })
})

describe.skipIf(!ffmpegPath)('renderVideo (ffmpeg smoke)', () => {
  it('renders an mp4 whose length matches the timeline', async () => {
    const result = await renderVideo(input, new SilentTts(), {
      limits: { minMs: 1000, maxMs: 60_000, maxBytes: 50 * 1024 * 1024 },
    })
    try {
      expect(Math.abs(result.durationMs - result.timeline.totalMs)).toBeLessThanOrEqual(1000)
      expect(result.sizeBytes).toBeGreaterThan(1000)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect((await readFile(result.path)).subarray(4, 8).toString()).toBe('ftyp')
    } finally {
      await result.cleanup()
    }
  }, 120_000)

  it('refuses a video longer than the limit before rendering frames', async () => {
    await expect(
      renderVideo(input, new SilentTts(), { limits: { minMs: 0, maxMs: 1000, maxBytes: 1 } }),
    ).rejects.toBeInstanceOf(RenderLimitError)
  })
})

describe('TTS adapters', () => {
  const capture = (response: () => Response) => {
    const calls: { url: string; init: RequestInit }[] = []
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return response()
    }) as unknown as typeof fetch
    return { calls, f }
  }

  it('asks OpenAI for raw pcm', async () => {
    const { calls, f } = capture(() => new Response(new Uint8Array(silence(100))))
    const pcm = await new OpenAiTts('k', 'alloy', f).synthesize('안녕.')
    expect(pcmDurationMs(pcm)).toBe(100)
    expect(JSON.parse(String(calls[0]?.init.body)).response_format).toBe('pcm')
  })

  it('asks ElevenLabs for pcm_24000 (its default is MP3)', async () => {
    const { calls, f } = capture(() => new Response(new Uint8Array(silence(50))))
    await new ElevenLabsTts('k', 'voice1', f).synthesize('안녕.')
    expect(calls[0]?.url).toContain('/text-to-speech/voice1?output_format=pcm_24000')
  })

  it('decodes Google base64 WAV through its chunks', async () => {
    const wav = writeWav(silence(200)).toString('base64')
    const { calls, f } = capture(() => new Response(JSON.stringify({ audioContent: wav })))
    const pcm = await new GoogleTts('k', 'ko-KR-Chirp3-HD-Charon', f).synthesize('안녕.')
    expect(pcmDurationMs(pcm)).toBe(200)
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.voice).toEqual({ languageCode: 'ko-KR', name: 'ko-KR-Chirp3-HD-Charon' })
    expect(body.audioConfig).toEqual({ audioEncoding: 'LINEAR16', sampleRateHertz: 24000 })
  })

  it('retries once on 5xx but not on 4xx', async () => {
    let n = 0
    const flaky = (async () => {
      n++
      return n === 1
        ? new Response('busy', { status: 503 })
        : new Response(new Uint8Array(silence(10)))
    }) as unknown as typeof fetch
    await new OpenAiTts('k', 'alloy', flaky).synthesize('a')
    expect(n).toBe(2)
    let m = 0
    const bad = (async () => {
      m++
      return new Response('bad voice', { status: 400 })
    }) as unknown as typeof fetch
    await expect(new OpenAiTts('k', 'x', bad).synthesize('a')).rejects.toThrow(/400/)
    expect(m).toBe(1)
  }, 10_000)
})

describe('TTS voice config', () => {
  const withConfig = (patch: Partial<typeof config>, fn: () => void) => {
    const saved = { ...config }
    Object.assign(config, patch)
    try {
      fn()
    } finally {
      Object.assign(config, saved)
    }
  }

  it('reads VIDEO_TTS_VOICE as the ElevenLabs voice while the provider is still silent', () => {
    withConfig(
      {
        VIDEO_TTS_PROVIDER: 'silent',
        VIDEO_TTS_VOICE: 'el-voice',
        ELEVENLABS_API_KEY: 'k',
        GOOGLE_TTS_API_KEY: 'g',
      },
      () => {
        expect(configuredProviders()).toContain('elevenlabs')
        expect(createTts('elevenlabs').voiceId).toBe('el-voice')
        // The other providers keep their default voice.
        expect(createTts('google').voiceId).toBe('ko-KR-Chirp3-HD-Charon')
      },
    )
  })

  it('keeps VIDEO_TTS_VOICE for the active provider once one is chosen', () => {
    withConfig(
      {
        VIDEO_TTS_PROVIDER: 'google',
        VIDEO_TTS_VOICE: 'ko-KR-Other',
        ELEVENLABS_API_KEY: 'k',
        GOOGLE_TTS_API_KEY: 'g',
      },
      () => {
        expect(createTts().voiceId).toBe('ko-KR-Other')
        expect(configuredProviders()).not.toContain('elevenlabs')
        expect(() => createTts('elevenlabs')).toThrow(/VIDEO_TTS_VOICE/)
      },
    )
  })
})

describe('storage', () => {
  it('names objects per render run', () => {
    expect(storageKey(7, 'abcd1234', 'f'.repeat(64))).toBe('v7/abcd1234-ffffffffffffffff.mp4')
  })

  it('treats a duplicate key as an earlier successful upload', () => {
    expect(isDuplicate(409, '')).toBe(true)
    expect(isDuplicate(400, '{"statusCode":"409","error":"Duplicate"}')).toBe(true)
    expect(isDuplicate(400, '{"error":"Invalid"}')).toBe(false)
  })

  it('stores, reads back and removes files locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ca-storage-'))
    try {
      const src = join(root, 'in.mp4')
      await writeFile(src, 'data')
      const s = new LocalStorage(join(root, 'store'))
      const url = await s.upload(src, 'v1/a.mp4')
      expect(url.startsWith('file:')).toBe(true)
      expect((await s.download(url)).toString()).toBe('data')
      await s.remove('v1/a.mp4')
      await expect(s.download(url)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uploads to Supabase without upsert and deletes by prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ca-supa-'))
    const calls: { url: string; init: RequestInit }[] = []
    try {
      const src = join(root, 'in.mp4')
      await writeFile(src, 'data')
      const s = new SupabaseStorage({
        url: 'https://p.supabase.co',
        serviceKey: 'sk',
        bucket: 'videos',
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({ url: String(url), init })
          return calls.length === 1
            ? new Response('{"statusCode":"409","error":"Duplicate"}', { status: 400 })
            : new Response('[]')
        }) as unknown as typeof fetch,
      })
      expect(await s.upload(src, 'v1/a.mp4')).toBe(
        'https://p.supabase.co/storage/v1/object/public/videos/v1/a.mp4',
      )
      expect((calls[0]?.init.headers as Record<string, string> | undefined)?.['x-upsert']).toBe(
        'false',
      )
      await s.remove('v1/a.mp4')
      expect(calls[1]?.init.method).toBe('DELETE')
      expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ prefixes: ['v1/a.mp4'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
