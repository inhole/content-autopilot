import { describe, expect, it } from 'vitest'
import {
  BLOG_BOT_COMMANDS,
  BLOG_HELP_LINES,
  extractBlogUrl,
  formatDraftCard,
  parseDraftReply,
} from '../src/campaigns/blog-telegram.ts'
import { encodeCampaignCallback, parseCampaignCallback } from '../src/campaigns/callbacks.ts'

describe('formatDraftCard', () => {
  const card = { id: 7, title: '이어폰 체험단', draft_title: '이어폰 후기', draft_body: '가나다라' }

  it('shows title, body, char count and photo count', () => {
    const text = formatDraftCard(card, 3, [])
    expect(text).toContain('#7')
    expect(text).toContain('제목: 이어폰 후기')
    expect(text).toContain('가나다라')
    expect(text).toContain('글자수 4자 · 사진 3장')
    expect(text).not.toContain('빠진 필수 키워드')
  })

  it('warns about missing keywords', () => {
    expect(formatDraftCard(card, 0, ['노이즈캔슬링', '배터리'])).toContain(
      '빠진 필수 키워드: 노이즈캔슬링, 배터리',
    )
  })

  it('truncates a very long body for the Telegram limit but counts all of it', () => {
    const text = formatDraftCard({ ...card, draft_body: '가'.repeat(5000) }, 0, [])
    expect(text.length).toBeLessThan(4096)
    expect(text).toContain('글자수 5,000자')
    expect(text).toContain('이하 생략')
  })
})

describe('parseDraftReply', () => {
  it('parses body edits, title edits and feedback', () => {
    expect(parseDraftReply('수정: 새 본문\n둘째 줄')).toEqual({
      kind: 'body',
      text: '새 본문\n둘째 줄',
    })
    expect(parseDraftReply('제목：새 제목')).toEqual({ kind: 'title', text: '새 제목' })
    expect(parseDraftReply('좀 더 담백하게 써줘')).toEqual({
      kind: 'feedback',
      text: '좀 더 담백하게 써줘',
    })
    expect(parseDraftReply('수정:   ')).toEqual({ kind: 'feedback', text: '수정:' })
  })
})

describe('extractBlogUrl', () => {
  it('finds a Naver blog url in free text', () => {
    expect(extractBlogUrl('올렸어요 https://blog.naver.com/me/223.')).toBe(
      'https://blog.naver.com/me/223',
    )
  })
  it('ignores other links', () => {
    expect(extractBlogUrl('https://example.com/a')).toBeNull()
    expect(extractBlogUrl('주소 없음')).toBeNull()
  })
})

describe('blog callbacks and help', () => {
  it('round-trips blog callback data', () => {
    const data = encodeCampaignCallback({ ns: 'blog', action: 'ok', campaignId: 12, revision: 4 })
    expect(parseCampaignCallback(data)).toMatchObject({ ns: 'blog', action: 'ok', revision: 4 })
  })
  it('exports help and commands', () => {
    expect(BLOG_HELP_LINES.some((l) => l.includes('/posted'))).toBe(true)
    expect(BLOG_BOT_COMMANDS[0]?.command).toBe('posted')
  })
})
