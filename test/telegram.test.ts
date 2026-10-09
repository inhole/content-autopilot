import { describe, expect, it } from 'vitest'
import { isCurrentReviewAction } from '../src/review/telegram.ts'

describe('isCurrentReviewAction', () => {
  const post = { status: 'PENDING_REVIEW', review_message_id: 10 }

  it('accepts the current review message', () => {
    expect(isCurrentReviewAction(post, 10)).toBe(true)
  })
  it('rejects a stale message', () => {
    expect(isCurrentReviewAction(post, 9)).toBe(false)
    expect(isCurrentReviewAction(post, undefined)).toBe(false)
  })
  it('rejects posts that are no longer pending', () => {
    expect(isCurrentReviewAction({ ...post, status: 'SCHEDULED' }, 10)).toBe(false)
  })
})
