import { describe, expect, it } from 'vitest'
import { encodeCampaignCallback, parseCampaignCallback } from '../src/campaigns/callbacks.ts'
import {
  CAMPAIGN_BOT_COMMANDS,
  CAMPAIGN_HELP_LINES,
  campaignCardButtons,
  daysUntil,
  formatActiveCampaigns,
  formatApplyResult,
  formatCampaignCard,
  formatDday,
  judgeCampaignPress,
  parseCampaignReply,
  rejectReasonButtons,
} from '../src/campaigns/telegram.ts'
import { CAMPAIGN_REJECT_REASONS, type Campaign } from '../src/campaigns/types.ts'

const TZ = 'Asia/Seoul'

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 12,
    source: 'revu',
    external_id: '12',
    url: 'https://www.revu.net/campaign/12',
    url_hash: 'h',
    found_in: null,
    status: 'PENDING_REVIEW',
    title: '무선 이어폰 체험단',
    type: 'delivery',
    category: null,
    reward_won: 59000,
    recruit_count: 10,
    apply_deadline: new Date('2026-10-25T09:00:00Z'), // 10/25 18:00 KST
    announce_at: new Date('2026-10-27T03:00:00Z'),
    review_deadline: new Date('2026-11-10T14:59:00Z'),
    keywords: ['이어폰', '음질'],
    detail: { offer: '무선 이어폰 1개' } as Campaign['detail'],
    score: 8.5,
    reason: '관심 품목이고 제공가치가 높아요',
    skip_reason: null,
    apply_message: '안녕하세요 정성껏 리뷰하겠습니다',
    revision: 2,
    review_chat_id: null,
    review_message_id: null,
    review_revision: null,
    reject_reason: null,
    claim_seq: 0,
    attempts: 0,
    last_error: null,
    screenshot_path: null,
    applied_at: null,
    selected_at: null,
    received_at: null,
    intake_message_id: null,
    memo: null,
    draft_title: null,
    draft_body: null,
    regen_seq: 0,
    draft_saved_at: null,
    blog_url: null,
    posted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  }
}

describe('daysUntil', () => {
  const now = new Date('2026-10-22T10:00:00Z') // 10/22 19:00 KST
  it('counts local calendar days', () => {
    expect(daysUntil(new Date('2026-10-25T09:00:00Z'), now, TZ)).toBe(3)
    expect(daysUntil(new Date('2026-10-22T14:00:00Z'), now, TZ)).toBe(0)
  })
  it('crosses KST midnight, not UTC midnight', () => {
    // 15:30Z is already the next day in KST even though UTC still says the 22nd
    expect(daysUntil(new Date('2026-10-22T15:30:00Z'), now, TZ)).toBe(1)
    // 23:30Z the 21st is 10/22 08:30 KST: same day
    expect(daysUntil(new Date('2026-10-21T23:30:00Z'), now, TZ)).toBe(0)
  })
  it('is negative once past', () => {
    expect(daysUntil(new Date('2026-10-20T00:00:00Z'), now, TZ)).toBe(-2)
  })
  it('formats D-n', () => {
    expect(formatDday(3)).toBe('D-3')
    expect(formatDday(0)).toBe('D-day')
    expect(formatDday(-2)).toBe('D+2')
  })
})

describe('formatCampaignCard', () => {
  const now = new Date('2026-10-22T10:00:00Z')
  const card = formatCampaignCard(campaign(), now, TZ, 300)

  it('shows the key facts', () => {
    expect(card).toContain('#12 무선 이어폰 체험단')
    expect(card).toContain('제공: 무선 이어폰 1개')
    expect(card).toContain('59,000원')
    expect(card).toContain('10명')
    expect(card).toContain('10/25(일) 18:00 (D-3)')
    expect(card).toContain('발표일: 10/27')
    expect(card).toContain('리뷰 마감: 11/10')
    expect(card).toContain('관심 품목이고 제공가치가 높아요')
    expect(card).toContain('8.5')
    expect(card).toContain('필수 키워드: 이어폰, 음질')
    expect(card).toContain('https://www.revu.net/campaign/12')
  })
  it('shows the apply message with its char count', () => {
    expect(card).toContain('(17/300자)')
    expect(card).toContain('안녕하세요 정성껏 리뷰하겠습니다')
  })
  it('counts characters, not UTF-16 units', () => {
    const c = formatCampaignCard(campaign({ apply_message: '😀😀😀' }), now, TZ, 300)
    expect(c).toContain('(3/300자)')
  })
  it('omits missing fields without breaking', () => {
    const bare = formatCampaignCard(
      campaign({
        title: null,
        detail: null,
        reward_won: null,
        recruit_count: null,
        apply_deadline: null,
        announce_at: null,
        review_deadline: null,
        keywords: [],
        score: null,
        reason: null,
        apply_message: null,
      }),
      now,
      TZ,
    )
    expect(bare).toContain('#12 (제목 없음)')
    expect(bare).not.toContain('undefined')
    expect(bare).not.toContain('null')
    expect(bare).not.toContain('신청 마감')
    expect(bare).not.toContain('필수 키워드')
    expect(bare).not.toContain('신청 메시지')
    expect(bare).toContain('https://www.revu.net/campaign/12')
  })
  it('stays within the Telegram limit', () => {
    const long = formatCampaignCard(campaign({ apply_message: 'a'.repeat(9000) }), now, TZ)
    expect(long.length).toBeLessThanOrEqual(4000)
  })
})

describe('buttons', () => {
  it('card buttons carry the revision and fit 64 bytes', () => {
    const buttons = campaignCardButtons(campaign({ revision: 7 }))
    expect(buttons.map((b) => b.callback.action)).toEqual(['applied', 'apply', 'pass'])
    for (const b of buttons) {
      expect(b.callback.revision).toBe(7)
      expect(Buffer.byteLength(encodeCampaignCallback(b.callback))).toBeLessThanOrEqual(64)
    }
  })
  it('reason picker has one button per reason plus cancel', () => {
    const buttons = rejectReasonButtons(campaign({ revision: 7 }))
    expect(buttons).toHaveLength(Object.keys(CAMPAIGN_REJECT_REASONS).length + 1)
    const last = buttons.at(-1)
    expect(last?.callback.action).toBe('passc')
    const args = buttons.slice(0, -1).map((b) => b.callback.arg)
    expect(args).toEqual(Object.keys(CAMPAIGN_REJECT_REASONS))
    for (const b of buttons) {
      const data = encodeCampaignCallback(b.callback)
      expect(parseCampaignCallback(data)).toEqual(b.callback)
      expect(b.callback.revision).toBe(7)
    }
  })
})

describe('formatActiveCampaigns', () => {
  const now = new Date('2026-10-22T10:00:00Z')
  it('says so when empty', () => {
    expect(formatActiveCampaigns([], now, TZ)).toContain('없어요')
  })
  it('groups by stage with D-n', () => {
    const text = formatActiveCampaigns(
      [
        campaign({ id: 1, status: 'PENDING_REVIEW' }),
        campaign({ id: 2, status: 'APPLY_FAILED', title: '실패건' }),
        campaign({ id: 3, status: 'APPLIED', announce_at: new Date('2026-10-23T03:00:00Z') }),
        campaign({
          id: 4,
          status: 'DRAFT_SAVED',
          review_deadline: new Date('2026-10-30T00:00:00Z'),
        }),
      ],
      now,
      TZ,
    )
    expect(text).toContain('신청 검토 대기 (1)')
    expect(text).toContain('#1 무선 이어폰 체험단 · D-3')
    expect(text).toContain('#2 실패건 [신청 실패] · D-3')
    expect(text).toContain('발표 대기 (1)')
    expect(text).toContain('#3 무선 이어폰 체험단 · D-1')
    expect(text).toContain('리뷰 작성 (1)')
    expect(text).toContain('#4 무선 이어폰 체험단 [임시저장 완료] · D-8')
  })
  it('omits D-n when the date is unknown', () => {
    const text = formatActiveCampaigns([campaign({ apply_deadline: null })], now, TZ)
    expect(text).toContain('#12 무선 이어폰 체험단')
    expect(text).not.toContain('D-')
  })
})

describe('formatApplyResult', () => {
  const c = { id: 5, title: '이어폰', url: 'https://www.revu.net/campaign/5' }
  it('reports each outcome', () => {
    expect(formatApplyResult(c, { kind: 'applied' })).toContain('신청을 완료')
    expect(formatApplyResult(c, { kind: 'dry-run' })).toContain('드라이런')
    const failed = formatApplyResult(c, { kind: 'failed', error: 'login expired' })
    expect(failed).toContain('login expired')
    expect(failed).toContain(c.url)
  })
})

describe('judgeCampaignPress', () => {
  const current = {
    status: 'PENDING_REVIEW' as const,
    review_message_id: 10,
    revision: 2,
    review_revision: 2,
  }
  const cb = { action: 'apply' as const, revision: 2 }

  it('accepts the current card', () => {
    expect(judgeCampaignPress(current, cb, 10)).toBe('ok')
  })
  it('rejects an older message', () => {
    expect(judgeCampaignPress(current, cb, 9)).toBe('stale')
    expect(judgeCampaignPress(current, cb, undefined)).toBe('stale')
  })
  it('rejects a button from an older revision', () => {
    expect(judgeCampaignPress(current, { action: 'apply', revision: 1 }, 10)).toBe('stale')
  })
  it('rejects the current message once the text moved on', () => {
    expect(judgeCampaignPress({ ...current, revision: 3 }, cb, 10)).toBe('stale')
    expect(judgeCampaignPress({ ...current, review_revision: null }, cb, 10)).toBe('stale')
  })
  it('rejects decided campaigns', () => {
    expect(judgeCampaignPress({ ...current, status: 'APPLIED' }, cb, 10)).toBe('stale')
  })
  it('lets retry through regardless of message and revision', () => {
    expect(
      judgeCampaignPress(
        { ...current, status: 'APPLY_FAILED' },
        { action: 'retry', revision: 0 },
        99,
      ),
    ).toBe('ok')
  })
  it('reports a missing campaign', () => {
    expect(judgeCampaignPress(null, cb, 10)).toBe('not-found')
  })
})

describe('parseCampaignReply', () => {
  it('treats 수정: as a verbatim edit', () => {
    expect(parseCampaignReply('수정: 새 신청 메시지')).toEqual({
      kind: 'edit',
      text: '새 신청 메시지',
    })
    expect(parseCampaignReply('수정：전각 콜론')).toEqual({ kind: 'edit', text: '전각 콜론' })
  })
  it('keeps an empty edit as an edit (the handler rejects it)', () => {
    expect(parseCampaignReply('수정:')).toEqual({ kind: 'edit', text: '' })
  })
  it('treats anything else as feedback', () => {
    expect(parseCampaignReply('더 짧게 써줘')).toEqual({ kind: 'feedback', text: '더 짧게 써줘' })
  })
})

describe('exports for the lead', () => {
  it('lists commands and help lines', () => {
    expect(CAMPAIGN_BOT_COMMANDS.map((c) => c.command)).toEqual(['camp', 'camps'])
    expect(CAMPAIGN_HELP_LINES.join('\n')).toContain('/camps')
  })
})
