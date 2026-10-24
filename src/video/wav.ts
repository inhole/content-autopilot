// 16-bit mono PCM at one sample rate is the only audio format inside the video pipeline. TTS
// adapters convert to it; the narration track is plain concatenation of PCM and silence.

export const SAMPLE_RATE = 24_000
const BYTES_PER_SAMPLE = 2

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; data: Buffer }

/**
 * Reads a RIFF/WAVE buffer by walking its chunks, so extra chunks (LIST, fact) and non-44-byte
 * headers are handled. Only PCM (format 1) is accepted.
 */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a RIFF file')
  }
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAVE file')
  let fmt: Omit<WavInfo, 'data'> | null = null
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body)
      if (format !== 1) throw new Error(`unsupported WAV format ${format} (PCM only)`)
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk')
      // Some encoders write 0 or 0xFFFFFFFF for streamed data: take the rest of the buffer.
      const end = size === 0 || body + size > buf.length ? buf.length : body + size
      return { ...fmt, data: buf.subarray(body, end) }
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

/** The PCM of a WAV, checked to be the pipeline format (mono, 16-bit, SAMPLE_RATE). */
export function pipelinePcm(wav: WavInfo): Buffer {
  if (wav.bitsPerSample !== 16 || wav.channels !== 1 || wav.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `unexpected audio format ${wav.sampleRate}Hz/${wav.channels}ch/${wav.bitsPerSample}bit` +
        ` (want ${SAMPLE_RATE}Hz mono 16-bit)`,
    )
  }
  return wav.data.length % 2 ? wav.data.subarray(0, wav.data.length - 1) : wav.data
}

export const pcmDurationMs = (pcm: Buffer) =>
  Math.round((pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000)

export const silence = (ms: number) =>
  Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE)

/** Wraps PCM in a canonical 44-byte WAV header. */
export function writeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
