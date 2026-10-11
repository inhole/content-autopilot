import { describe, expect, it } from 'vitest'
import {
  formatReplyNotification,
  type NewReply,
  selectNotifiable,
  validateAnswer,
} from '../src/pipeline/replies.ts'
import { DryRunThreadsClient, parseReplies } from '../src/threads/client.ts'

describe('parseReplies', () => {
  it('parses full and sparse entries defensively', () => {
    const replies = parseReplies({
      data: [
        {
          id: '1',
          text: '좋은 글이네요',
          username: 'alice',
          timestamp: '2026-10-11T01:02:03+0000',
          permalink: 'https://www.threads.net/@alice/post/x',
          is_reply_owned_by_me: false,
          hide_status: 'NOT_HUSHED',
        },
        { id: '2' },
        { id: '3', text: '   ', username: null, timestamp: 'garbage' },
      ],
    })
    expect(replies[0]).toMatchObject({ id: '1', text: '좋은 글이네요', username: 'alice' })
    expect(replies[0]?.hidden).toBe(false)
    expect(replies[0]?.timestamp?.toISOString()).toBe('2026-10-11T01:02:03.000Z')
    expect(replies[1]).toMatchObject({ text: null, username: null, timestamp: null })
    expect(replies[2]).toMatchObject({ text: null, timestamp: null })
  })

  it('treats a missing data field as no replies', () => {
    expect(parseReplies({})).toEqual([])
  })

  it('flags owned and hidden replies, which are not notified', () => {
    const replies = parseReplies({
      data: [
        { id: 'a', text: 'mine', is_reply_owned_by_me: true },
        { id: 'b', text: 'hidden', hide_status: 'HIDDEN' },
        { id: 'c', text: 'ok', hide_status: 'UNHUSHED' },
      ],
    })
    expect(selectNotifiable(replies).map((r) => r.id)).toEqual(['c'])
  })
})

describe('formatReplyNotification', () => {
  const reply: NewReply = {
    id: '1',
    post_id: 12,
    username: 'alice',
    text: '어떻게 쓰나요?',
    permalink: 'https://threads.net/p/1',
    post_text: '첫 줄입니다\n둘째 줄',
  }

  it('shows user, post, first line and the reply text', () => {
    const text = formatReplyNotification(reply)
    expect(text).toContain('💬 @alice 답글 · 글 #12 "첫 줄입니다"')
    expect(text).toContain('어떻게 쓰나요?')
    expect(text).toContain('이 메시지에 답장하면 Threads 답글로 달려요.')
  })

  it('handles a reply without text or user, and truncates a long first line', () => {
    const text = formatReplyNotification({
      ...reply,
      username: null,
      text: null,
      permalink: null,
      post_text: 'a'.repeat(100),
    })
    expect(text).toContain('텍스트가 없는')
    expect(text).toContain(`"${'a'.repeat(30)}…"`)
  })
})

describe('validateAnswer', () => {
  it('trims and accepts text up to the limit', () => {
    expect(validateAnswer('  hi  ')).toBe('hi')
    expect(validateAnswer('가'.repeat(500))).toHaveLength(500)
  })

  it('rejects empty and over-limit text with a Korean message', () => {
    expect(() => validateAnswer('  ')).toThrow(/비어/)
    expect(() => validateAnswer('가'.repeat(501))).toThrow(/500자.*501자/)
  })
})

describe('DryRunThreadsClient replies', () => {
  it('lists nothing and fakes the reply id', async () => {
    const api = new DryRunThreadsClient()
    expect(await api.listReplies()).toEqual([])
    expect(await api.replyTo('r1', 'hi')).toMatch(/^dry-/)
  })
})
