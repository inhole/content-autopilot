import { describe, expect, it } from 'vitest'
import { encodeCampaignCallback, parseCampaignCallback } from '../src/campaigns/callbacks.ts'
import {
  draftControlButtons,
  formatDraftControl,
  intakeText,
  judgeReviewPress,
  parseReviewReply,
  REVIEW_HELP_LINES,
} from '../src/campaigns/review-telegram.ts'

const review = { tone: 't', minChars: 100, maxChars: 500, points: [] }

describe('formatDraftControl', () => {
  it('shows the count and range', () => {
    const text = formatDraftControl({ id: 7, draft_text: '가'.repeat(150) }, { review })
    expect(text).toBe(
      '📝 #7 리뷰 초안 · 150자 (100~500자)\n위 메시지를 길게 눌러 복사해 카카오톡 선물하기 상품 리뷰에 붙여 넣으세요.',
    )
  })
  it('warns when outside the range', () => {
    expect(formatDraftControl({ id: 7, draft_text: '가'.repeat(60) }, { review })).toContain(
      '40자 짧아요',
    )
    expect(formatDraftControl({ id: 7, draft_text: '가'.repeat(510) }, { review })).toContain(
      '10자 길어요',
    )
  })
})

describe('intakeText', () => {
  it('asks for a reply with the memo', () => {
    const text = intakeText({ id: 3, title: '이어폰' })
    expect(text.startsWith('#3 이어폰\n이 메시지에 답장으로 사용 메모를')).toBe(true)
  })
})

describe('draftControlButtons', () => {
  it('binds regen and done to the revision', () => {
    const buttons = draftControlButtons({ id: 7, revision: 4 })
    expect(buttons.map((b) => b.text)).toEqual(['🔁 다시 쓰기', '✅ 리뷰 올림'])
    const data = buttons.map((b) => ('callback' in b ? encodeCampaignCallback(b.callback) : b.url))
    expect(data).toEqual(['rev:regen:7:4', 'rev:done:7:4'])
    expect(parseCampaignCallback(data[1] ?? '')?.action).toBe('done')
  })
})

describe('parseReviewReply', () => {
  it('treats 수정: as a verbatim edit', () => {
    expect(parseReviewReply('수정: 새 리뷰입니다')).toEqual({ kind: 'edit', text: '새 리뷰입니다' })
    expect(parseReviewReply('수정：전각 콜론')).toEqual({ kind: 'edit', text: '전각 콜론' })
  })
  it('treats anything else as feedback', () => {
    expect(parseReviewReply(' 더 짧게 써줘 ')).toEqual({ kind: 'feedback', text: '더 짧게 써줘' })
    expect(parseReviewReply('수정해줘')).toEqual({ kind: 'feedback', text: '수정해줘' })
  })
})

describe('judgeReviewPress', () => {
  const current = {
    status: 'DRAFT_REVIEW',
    review_message_id: 50,
    revision: 2,
    review_revision: 2,
  } as const
  it('accepts the current control message at its revision', () => {
    expect(judgeReviewPress(current, { revision: 2 }, 50)).toBe('ok')
  })
  it('refuses an old message, revision or status', () => {
    expect(judgeReviewPress(current, { revision: 2 }, 49)).toBe('stale')
    expect(judgeReviewPress(current, { revision: 1 }, 50)).toBe('stale')
    expect(judgeReviewPress({ ...current, revision: 3 }, { revision: 2 }, 50)).toBe('stale')
    expect(judgeReviewPress({ ...current, status: 'POSTED' }, { revision: 2 }, 50)).toBe('stale')
  })
  it('reports a missing campaign', () => {
    expect(judgeReviewPress(null, { revision: 0 }, 1)).toBe('not-found')
  })
})

describe('REVIEW_HELP_LINES', () => {
  it('is a non-empty list of lines', () => {
    expect(REVIEW_HELP_LINES.length).toBeGreaterThan(0)
  })
})

describe('formatDraftControl per source', () => {
  it('points at the review place of the source', () => {
    const review = { minChars: 100, maxChars: 500, tone: 't', points: [] }
    expect(formatDraftControl({ id: 7, draft_text: '가'.repeat(150) }, { review })).toContain(
      '카카오톡 선물하기 상품 리뷰',
    )
    expect(
      formatDraftControl({ id: 7, draft_text: '가'.repeat(150), source: 'musinsa' }, { review }),
    ).toContain('무신사 상품 후기')
  })
})
