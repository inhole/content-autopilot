import { describe, expect, it } from 'vitest'
import { isCurrentReviewAction } from '../src/review/telegram.ts'

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
