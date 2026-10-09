import { describe, expect, it } from 'vitest'
import { isCurrentReviewAction, parseCallback } from '../src/review/telegram.ts'

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
