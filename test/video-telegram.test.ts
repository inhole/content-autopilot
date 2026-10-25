import { describe, expect, it } from 'vitest'
import type { VideoRow } from '../src/video/store.ts'
import { guardSql } from '../src/video/store.ts'
import {
  approvedVideoText,
  encodeManualDone,
  encodePubRetry,
  encodeVideoAction,
  formatVideoReview,
  parseManualDone,
  parsePubRetry,
  parseVideoAction,
  parseVideoReply,
  publicationFailedText,
} from '../src/video/telegram.ts'

describe('callbacks', () => {
  it('round-trips the review, retry and manual buttons within 64 bytes', () => {
    const data = encodeVideoAction('ok', 123456, 42)
    expect(data.length).toBeLessThanOrEqual(64)
    expect(parseVideoAction(data)).toEqual({ action: 'ok', videoId: 123456, revision: 42 })
    expect(parseVideoAction('vid:nope:1:1')).toBeNull()
    expect(parsePubRetry(encodePubRetry(9))).toBe(9)
    expect(parseManualDone(encodeManualDone(5))).toBe(5)
    expect(parsePubRetry('vpub:retry:x')).toBeNull()
  })
})

describe('parseVideoReply', () => {
  it('reads scene, title and caption edits; anything else is feedback', () => {
    expect(parseVideoReply('수정2: 새 문장이야.')).toEqual({
      kind: 'edit',
      op: { kind: 'narration', idx: 2, text: '새 문장이야.' },
    })
    expect(parseVideoReply('화면 3 : 새 문구')).toEqual({
      kind: 'edit',
      op: { kind: 'heading', idx: 3, text: '새 문구' },
    })
    expect(parseVideoReply('제목： 새 제목')).toEqual({
      kind: 'edit',
      op: { kind: 'title', text: '새 제목' },
    })
    expect(parseVideoReply('캡션: 새 캡션')).toEqual({
      kind: 'edit',
      op: { kind: 'caption', text: '새 캡션' },
    })
    expect(parseVideoReply('훅을 더 세게')).toEqual({ kind: 'feedback' })
    // `수정:` without a scene number is feedback, not an edit of scene 1.
    expect(parseVideoReply('수정: 전체를 바꿔')).toEqual({ kind: 'feedback' })
  })
})

describe('guardSql', () => {
  it('binds buttons to the message and revision, replies to either registered message', () => {
    expect(guardSql({ messageId: 5, revision: 3 }, 2)).toEqual({
      sql: 'review_message_id = $2 and revision = $3 and review_revision = revision',
      params: [5, 3],
    })
    expect(guardSql({ replyTo: 9 }, 4).sql).toBe(
      '$4 in (review_message_id, script_message_id) and review_revision = revision',
    )
    expect(guardSql({ revision: 1 }, 2)).toEqual({ sql: 'revision = $2', params: [1] })
  })
})

const row = (over: Partial<VideoRow> = {}): VideoRow => ({
  id: 3,
  post_id: 11,
  status: 'PENDING_REVIEW',
  title: '제목',
  caption: '캡션',
  hashtags: ['AI'],
  scenes: [
    { heading: '훅', narration: '첫 문장.' },
    { heading: '본문', narration: '둘째 문장.' },
  ],
  source_url: 'https://example.com/a',
  source_label: 'example.com',
  generation: null,
  revision: 2,
  regen_seq: 1,
  regen_feedback: null,
  stage_recoveries: 0,
  render_hash: 'h',
  video_url: 'file:///v.mp4',
  storage_key: 'v3/x.mp4',
  duration_ms: 31_400,
  size_bytes: 100,
  review_chat_id: null,
  review_message_id: null,
  script_message_id: null,
  review_revision: null,
  last_error: null,
  published_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...over,
})

describe('formatVideoReview', () => {
  it('shows header, scenes, caption and the reply help', () => {
    const text = formatVideoReview(row(), { silent: true })
    expect(text).toContain('🎬 영상 #3 · 31초 · 장면 2 · 원본 글 #11')
    expect(text).toContain('🔇 무음')
    expect(text).toContain('[2] 본문\n둘째 문장.')
    expect(text).toContain('출처: https://example.com/a')
    expect(text).toContain('수정N:')
  })

  it('stays within the Telegram message limit', () => {
    const long = row({ caption: 'x'.repeat(5000) })
    expect([...formatVideoReview(long)].length).toBeLessThanOrEqual(4096)
  })
})

describe('notification texts', () => {
  it('describes the approval with or without automatic platforms', () => {
    expect(approvedVideoText(3, { at: null, platforms: [] })).toMatch(/직접 올리고/)
    expect(
      approvedVideoText(3, {
        at: new Date('2026-10-25T10:00:00Z'),
        platforms: ['REELS', 'SHORTS'],
      }),
    ).toMatch(/Instagram Reels · YouTube Shorts 발행 예정/)
  })

  it('adds a hint for token and account failures', () => {
    expect(publicationFailedText(1, 'REELS', 'boom', 'auth')).toMatch(/토큰을 확인/)
    expect(publicationFailedText(1, 'SHORTS', 'boom', 'account')).toMatch(/계정이 승인 때와 달라요/)
    expect(publicationFailedText(1, 'SHORTS', 'boom', 'other')).toBe(
      '❌ 영상 #1 YouTube Shorts 발행 실패: boom',
    )
  })
})
