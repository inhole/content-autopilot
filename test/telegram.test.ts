import { describe, expect, it } from 'vitest'
import {
  encodeScheduleAction,
  formatReview,
  HELP_TEXT,
  isCurrentReviewAction,
  parseCallback,
  parseReviewReply,
  parseScheduleAction,
} from '../src/review/telegram.ts'

describe('schedule action callback data', () => {
  const at = new Date('2026-10-09T03:00:00Z')
  it('round-trips and stays within the 64-byte limit', () => {
    const data = encodeScheduleAction('unsched', 123456, at)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseScheduleAction(data)).toEqual({
      action: 'unsched',
      postId: 123456,
      scheduledAt: at,
    })
    expect(parseScheduleAction(encodeScheduleAction('pubnow', 1, at))?.action).toBe('pubnow')
  })
  it('ignores other callbacks and malformed data', () => {
    expect(parseScheduleAction('approve:5')).toBeNull()
    expect(parseScheduleAction('unsched:5')).toBeNull()
    expect(parseScheduleAction('unsched:x:1')).toBeNull()
  })
})

describe('HELP_TEXT', () => {
  it('lists the commands and reply conventions', () => {
    for (const s of ['/status', '/add', '/help', '수정:', '수정2:', '삭제2', '피드백'])
      expect(HELP_TEXT).toContain(s)
  })
})

describe('isCurrentReviewAction', () => {
  const post = { status: 'PENDING_REVIEW', review_message_id: 10, revision: 2, review_revision: 2 }

  it('accepts the current review message', () => {
    expect(isCurrentReviewAction(post, 10)).toBe(true)
  })
  it('rejects a stale message', () => {
    expect(isCurrentReviewAction(post, 9)).toBe(false)
    expect(isCurrentReviewAction(post, undefined)).toBe(false)
  })
  it('rejects the current message once the text moved to a newer revision', () => {
    expect(isCurrentReviewAction({ ...post, revision: 3 }, 10)).toBe(false)
    expect(isCurrentReviewAction({ ...post, review_revision: null }, 10)).toBe(false)
  })
  it('rejects posts that are no longer pending', () => {
    expect(isCurrentReviewAction({ ...post, status: 'SCHEDULED' }, 10)).toBe(false)
  })
})

describe('parseCallback', () => {
  it('parses plain actions', () => {
    expect(parseCallback('reject:12')).toEqual({ action: 'reject', postId: 12 })
  })
  it('parses a reject reason', () => {
    expect(parseCallback('rr:12:boring')).toEqual({ action: 'rr', postId: 12, reason: 'boring' })
  })
  it('rejects unknown reasons and bad ids', () => {
    expect(parseCallback('rr:12:nope')).toBeNull()
    expect(parseCallback('approve:x')).toBeNull()
  })
  it('stays under the 64-byte callback limit', () => {
    expect(new TextEncoder().encode('rr:9999999999:boring').length).toBeLessThan(64)
  })
})

describe('parseReviewReply', () => {
  it('treats 수정: and 수정1: as a main text edit', () => {
    expect(parseReviewReply('수정: 새 본문')).toEqual({ kind: 'edit', idx: 1, text: '새 본문' })
    expect(parseReviewReply('수정1：새 본문')).toEqual({ kind: 'edit', idx: 1, text: '새 본문' })
  })
  it('parses follow-up edits with optional spaces and a full-width colon', () => {
    expect(parseReviewReply('수정2: a\nb')).toEqual({ kind: 'edit', idx: 2, text: 'a\nb' })
    expect(parseReviewReply('수정 3 ： c')).toEqual({ kind: 'edit', idx: 3, text: 'c' })
    expect(parseReviewReply('수정2:')).toEqual({ kind: 'edit', idx: 2, text: '' })
  })
  it('parses deletes', () => {
    expect(parseReviewReply('삭제2')).toEqual({ kind: 'delete', idx: 2 })
    expect(parseReviewReply(' 삭제 3 ')).toEqual({ kind: 'delete', idx: 3 })
  })
  it('treats everything else as feedback', () => {
    for (const s of ['더 짧게', '삭제', '삭제2번 해줘', '수정해줘', '수정2 내용']) {
      expect(parseReviewReply(s)).toEqual({ kind: 'feedback' })
    }
  })
})

describe('formatReview', () => {
  const post = {
    id: 12,
    topic_id: 1,
    revision: 1,
    text: 'main',
    angle: '관점',
    source_url: 'https://example.com/a',
    caveats: null,
    score: 8,
  }
  it('keeps the single post format without parts', () => {
    const out = formatReview(post, { cta: '팔로우' })
    expect(out).toContain('📝 초안 #12 · 점수 8 · 4/500자\n\nmain\n\n관점: 관점')
    expect(out).not.toContain('CTA')
    expect(out).toContain('답장: "수정: <새 본문>"은 그대로 교체')
  })
  it('numbers a chain and shows the CTA budget on the last part', () => {
    const out = formatReview(post, { parts: ['one', 'two'], cta: '팔로우' })
    expect(out).toContain('연결 글 3개')
    expect(out).toContain('[1/3] 본 글 (4/500자)\nmain')
    expect(out).toContain('[2/3] 답글 (3/500자)\none')
    expect(out).toContain('[3/3] 답글 (3/495자) + CTA·링크\ntwo')
    expect(out).toContain('— CTA: 팔로우')
    expect(out).toContain('삭제2')
  })
  it('omits CTA and link markers when absent', () => {
    const out = formatReview({ ...post, source_url: null }, { parts: ['one'] })
    expect(out).toContain('[2/2] 답글 (3/500자)\none')
    expect(out).not.toContain('CTA')
    expect(out).not.toContain('+ ')
  })
})
