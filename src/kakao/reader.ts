import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SCRIPT_PATH = fileURLToPath(new URL('./read-room.ps1', import.meta.url))

export type KakaoMessage = {
  sender: string
  /** As shown, e.g. "오후 1:23". */
  time: string
  body: string
  /** YYYY-MM-DD from the latest date separator (or the line itself in export files), else null. */
  date: string | null
}

/** Copies the whole transcript of a KakaoTalk PC chat room through the clipboard (Windows only). */
export async function readKakaoRoom(room: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-Room', room],
      { timeout: 60_000, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    return stdout.replace(/^﻿/, '')
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new Error(`KakaoTalk read failed for "${room}": ${stderr || (err as Error).message}`)
  }
}

const TIME = '((?:오전|오후|AM|PM)\\s*\\d{1,2}:\\d{2})'
// "[홍길동] [오후 1:23] 메시지" (clipboard copy)
const COPY_LINE = new RegExp(`^\\[([^\\]]+)\\]\\s*\\[${TIME}\\]\\s?(.*)$`, 'i')
// "2026. 10. 18. 오후 1:23, 홍길동 : 메시지" and "2026년 10월 18일 오후 1:23, 홍길동 : 메시지" (export file)
const EXPORT_LINE = new RegExp(
  `^(\\d{4})(?:\\.\\s*|년\\s*)(\\d{1,2})(?:\\.\\s*|월\\s*)(\\d{1,2})(?:\\.|일)?\\s*${TIME},\\s*(.+?) : (.*)$`,
  'i',
)
// "2026년 10월 18일 토요일", optionally wrapped in dashes
const DATE_LINE = /^[-\s]*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*[가-힣]요일)?[-\s]*$/

const isoDate = (y: string, m: string, d: string) =>
  `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`

/**
 * Parses KakaoTalk PC clipboard text or an exported chat file. Lenient: a line that matches no
 * format continues the previous message body, and lines before the first message are dropped.
 */
export function parseKakaoTranscript(text: string): KakaoMessage[] {
  const messages: KakaoMessage[] = []
  let date: string | null = null
  let current: KakaoMessage | null = null

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trimEnd()

    const dateMatch = DATE_LINE.exec(line)
    if (dateMatch) {
      date = isoDate(dateMatch[1] as string, dateMatch[2] as string, dateMatch[3] as string)
      current = null
      continue
    }

    const copy = COPY_LINE.exec(line)
    if (copy) {
      current = {
        sender: copy[1] as string,
        time: norm(copy[2] as string),
        body: copy[3] ?? '',
        date,
      }
      messages.push(current)
      continue
    }

    const exp = EXPORT_LINE.exec(line)
    if (exp) {
      date = isoDate(exp[1] as string, exp[2] as string, exp[3] as string)
      current = { sender: exp[5] as string, time: norm(exp[4] as string), body: exp[6] ?? '', date }
      messages.push(current)
      continue
    }

    if (current) current.body += `\n${line}`
  }

  for (const m of messages) m.body = m.body.replace(/\s+$/, '')
  return messages
}

const norm = (time: string) => time.replace(/\s+/g, ' ').trim()

/**
 * Stable id of a message. `occurrence` is the index among identical messages (same date, time,
 * sender and body) in one transcript, so real repeats stay distinct while re-reading the same
 * transcript yields the same hashes.
 */
export function messageHash(room: string, m: KakaoMessage, occurrence: number): string {
  return createHash('sha256')
    .update([room, m.date ?? '', m.time, m.sender, m.body, occurrence].join('|'))
    .digest('hex')
}

/** Hashes every message of a transcript, numbering identical ones in order. */
export function hashTranscript(room: string, messages: KakaoMessage[]): string[] {
  const seen = new Map<string, number>()
  return messages.map((m) => {
    const key = [m.date, m.time, m.sender, m.body].join('\u0000')
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    return messageHash(room, m, occurrence)
  })
}
