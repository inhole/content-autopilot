import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hashTranscript, messageHash, parseKakaoTranscript } from '../src/kakao/reader.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/kakao/${name}`, import.meta.url), 'utf8')

describe('parseKakaoTranscript', () => {
  it('parses clipboard copy with separators and multi-line bodies', () => {
    const msgs = parseKakaoTranscript(fixture('copy.txt'))
    expect(msgs).toEqual([
      {
        sender: '체험단봇',
        time: '오전 9:05',
        date: '2026-10-17',
        body: '오늘의 체험단\nhttps://www.revu.net/campaign/111111\n맛집 배달 체험 신청하세요',
      },
      { sender: '홍길동', time: '오후 1:23', date: '2026-10-17', body: '감사합니다!' },
      {
        sender: '홍길동',
        time: '오전 8:00',
        date: '2026-10-18',
        body: '새 캠페인 revu.net/campaign/222222?utm=kakao 입니다',
      },
    ])
  })

  it('parses the export file format', () => {
    const msgs = parseKakaoTranscript(fixture('export.txt'))
    expect(msgs).toEqual([
      { sender: '홍길동', time: '오후 1:23', date: '2026-10-17', body: '안녕하세요' },
      {
        sender: '김철수',
        time: '오후 1:24',
        date: '2026-10-17',
        body: '이거 보세요\nhttps://m.revu.net/campaign/333333',
      },
      { sender: '홍길동', time: '오전 8:00', date: '2026-10-18', body: '시각 : 10시' },
    ])
  })

  it('parses the Korean date export variant and CRLF', () => {
    const msgs = parseKakaoTranscript('2026년 10월 18일 오후 1:23, 홍길동 : 안녕\r\n둘째 줄\r\n')
    expect(msgs).toEqual([
      { sender: '홍길동', time: '오후 1:23', date: '2026-10-18', body: '안녕\n둘째 줄' },
    ])
  })

  it('keeps date null before any separator and drops leading noise', () => {
    const msgs = parseKakaoTranscript('header noise\n[A] [오후 1:00] hi')
    expect(msgs).toEqual([{ sender: 'A', time: '오후 1:00', date: null, body: 'hi' }])
  })

  it('handles empty input', () => {
    expect(parseKakaoTranscript('')).toEqual([])
  })
})

describe('message hashes', () => {
  const m = { sender: 'A', time: '오후 1:00', date: '2026-10-18', body: 'hi' }

  it('is stable and depends on room, content and occurrence', () => {
    expect(messageHash('r', m, 0)).toBe(messageHash('r', { ...m }, 0))
    expect(messageHash('r', m, 0)).not.toBe(messageHash('r', m, 1))
    expect(messageHash('r', m, 0)).not.toBe(messageHash('other', m, 0))
    expect(messageHash('r', m, 0)).not.toBe(messageHash('r', { ...m, body: 'ho' }, 0))
  })

  it('numbers identical messages so repeats differ but re-reads match', () => {
    const list = [m, m, { ...m, body: 'x' }]
    const first = hashTranscript('r', list)
    expect(new Set(first).size).toBe(3)
    expect(hashTranscript('r', [...list])).toEqual(first)
  })
})
