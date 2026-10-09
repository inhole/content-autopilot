import { describe, expect, it } from 'vitest'
import { parseAddCommand } from '../src/review/telegram.ts'

describe('parseAddCommand', () => {
  it('parses a url with a note', () => {
    expect(parseAddCommand('/add https://example.com/a 이건 과대평가 같다')).toEqual({
      url: 'https://example.com/a',
      note: '이건 과대평가 같다',
    })
  })

  it('parses a url without a note', () => {
    expect(parseAddCommand('/add https://example.com/a')).toEqual({
      url: 'https://example.com/a',
      note: undefined,
    })
  })

  it('accepts the @bot suffix and extra whitespace', () => {
    expect(parseAddCommand('/add@my_bot   https://example.com/a   의견  ')).toEqual({
      url: 'https://example.com/a',
      note: '의견',
    })
  })

  it('rejects a missing or invalid url', () => {
    for (const text of ['/add', '/add 그냥 의견', '/add ftp://example.com/a', '/add example.com']) {
      expect(parseAddCommand(text)).toEqual({ error: '사용법: /add <url> [한 줄 의견]' })
    }
  })
})
