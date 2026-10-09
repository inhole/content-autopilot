import { describe, expect, it } from 'vitest'
import {
  encodeScheduleAction,
  HELP_TEXT,
  isCurrentReviewAction,
  parseCallback,
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
    for (const s of ['/status', '/add', '/help', '수정:', '피드백']) expect(HELP_TEXT).toContain(s)
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
