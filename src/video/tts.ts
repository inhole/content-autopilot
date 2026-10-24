import { config } from '../config.ts'
import { charCount } from './types.ts'
import { parseWav, pipelinePcm, SAMPLE_RATE, silence } from './wav.ts'

// Text-to-speech adapters (docs/plans/video.md 3-3). Each returns 16-bit mono PCM at SAMPLE_RATE;
// the providers' own formats differ (Google: base64 WAV, OpenAI: raw PCM, ElevenLabs: raw PCM
// only when output_format asks for it, MP3 otherwise).

export type TtsProviderName = 'silent' | 'google' | 'openai' | 'elevenlabs'

export interface TtsProvider {
  readonly name: TtsProviderName
  /** Identifies the voice for the render hash: a different voice is a different video. */
  readonly voiceId: string
  synthesize(text: string): Promise<Buffer>
}

/** Silent speech for development without a key; length is roughly Korean speaking speed. */
export const SILENT_CHARS_PER_SECOND = 7

const DEFAULT_VOICES: Record<Exclude<TtsProviderName, 'silent'>, string | null> = {
  google: 'ko-KR-Chirp3-HD-Charon',
  openai: 'alloy',
  // ElevenLabs voices are account-specific ids; there is no safe default.
  elevenlabs: null,
}
const OPENAI_MODEL = 'gpt-4o-mini-tts'
const ELEVENLABS_MODEL = 'eleven_multilingual_v2'
const TIMEOUT_MS = 60_000

type Fetch = typeof fetch

/** A 4xx other than 429: the request itself is wrong, so retrying cannot help. */
class TtsRequestError extends Error {}

/** POST with one retry on 429/5xx/network errors. Returns the response body. */
async function post(
  f: Fetch,
  url: string,
  init: { headers: Record<string, string>; body: string },
  label: string,
): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_500))
    try {
      const res = await f(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = Buffer.from(await res.arrayBuffer())
      if (res.ok) return body
      const message = `${label} TTS ${res.status}: ${body.toString('utf8').slice(0, 300)}`
      if (res.status !== 429 && res.status < 500) throw new TtsRequestError(message)
      lastError = new Error(message)
    } catch (err) {
      if (err instanceof TtsRequestError) throw err
      lastError = err
    }
  }
  throw lastError
}

export class SilentTts implements TtsProvider {
  readonly name = 'silent' as const
  readonly voiceId = 'silent'
  async synthesize(text: string): Promise<Buffer> {
    return silence(Math.max(600, (charCount(text) / SILENT_CHARS_PER_SECOND) * 1000))
  }
}

export class GoogleTts implements TtsProvider {
  readonly name = 'google' as const
  constructor(
    private readonly apiKey: string,
    readonly voiceId: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}
  async synthesize(text: string): Promise<Buffer> {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.apiKey)}`
    const body = await post(
      this.fetchFn,
      url,
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: this.voiceId.slice(0, 5), name: this.voiceId },
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE },
        }),
      },
      'Google',
    )
    const parsed = JSON.parse(body.toString('utf8')) as { audioContent?: string }
    if (!parsed.audioContent) throw new Error('Google TTS returned no audioContent')
    return googleAudioToPcm(Buffer.from(parsed.audioContent, 'base64'))
  }
}

/** Google's LINEAR16 is a WAV file; read its chunks instead of assuming a 44-byte header. */
export function googleAudioToPcm(audio: Buffer): Buffer {
  return pipelinePcm(parseWav(audio))
}

export class OpenAiTts implements TtsProvider {
  readonly name = 'openai' as const
  constructor(
    private readonly apiKey: string,
    readonly voiceId: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}
  async synthesize(text: string): Promise<Buffer> {
    // `pcm` is headerless 24kHz 16-bit mono, the pipeline format.
    const pcm = await post(
      this.fetchFn,
      'https://api.openai.com/v1/audio/speech',
      {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          voice: this.voiceId,
          input: text,
          response_format: 'pcm',
          instructions: '한국어 원어민처럼 자연스럽게, 친구에게 소식을 전하듯 차분한 속도로 읽어.',
        }),
      },
      'OpenAI',
    )
    return evenLength(pcm)
  }
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs' as const
  constructor(
    private readonly apiKey: string,
    readonly voiceId: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}
  async synthesize(text: string): Promise<Buffer> {
    // Without output_format the API answers MP3.
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=pcm_${SAMPLE_RATE}`
    const pcm = await post(
      this.fetchFn,
      url,
      {
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      },
      'ElevenLabs',
    )
    return evenLength(pcm)
  }
}

const evenLength = (pcm: Buffer) => (pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm)

/** Builds a provider from config (or an explicit name, for the sample CLI). */
export function createTts(name: TtsProviderName = config.VIDEO_TTS_PROVIDER): TtsProvider {
  const voice = config.VIDEO_TTS_PROVIDER === name ? config.VIDEO_TTS_VOICE : undefined
  const need = (key: string | undefined, env: string) => {
    if (!key) throw new Error(`${env} is not set (VIDEO_TTS_PROVIDER=${name})`)
    return key
  }
  switch (name) {
    case 'silent':
      return new SilentTts()
    case 'google':
      return new GoogleTts(
        need(config.GOOGLE_TTS_API_KEY, 'GOOGLE_TTS_API_KEY'),
        voice ?? (DEFAULT_VOICES.google as string),
      )
    case 'openai':
      return new OpenAiTts(
        need(config.OPENAI_API_KEY, 'OPENAI_API_KEY'),
        voice ?? (DEFAULT_VOICES.openai as string),
      )
    case 'elevenlabs':
      return new ElevenLabsTts(
        need(config.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY'),
        need(voice, 'VIDEO_TTS_VOICE'),
      )
  }
}

/** Providers with a key configured, for `video:tts-sample`. */
export function configuredProviders(): TtsProviderName[] {
  const names: TtsProviderName[] = []
  if (config.GOOGLE_TTS_API_KEY) names.push('google')
  if (config.OPENAI_API_KEY) names.push('openai')
  if (config.ELEVENLABS_API_KEY && config.VIDEO_TTS_VOICE) names.push('elevenlabs')
  return names
}
