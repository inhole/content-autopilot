import { describe, expect, it } from 'vitest'
import { encodeCampaignCallback } from '../src/campaigns/callbacks.ts'
import {
  CAMPAIGN_BOT_COMMANDS,
  CAMPAIGN_HELP_LINES,
  campaignCardButtons,
  daysUntil,
  formatActiveCampaigns,
  formatCampaignCard,
  formatDday,
  judgeCampaignPress,
  parseDueDate,
  rejectReasonButtons,
} from '../src/campaigns/telegram.ts'
import { CAMPAIGN_REJECT_REASONS, type Campaign } from '../src/campaigns/types.ts'

const TZ = 'Asia/Seoul'

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 12,
    source: 'kakao-gift',
    external_id: 'g12',
    url: 'https://gift.kakao.com/product/12',
    url_hash: 'h',
    status: 'PENDING_REVIEW',
    title: '무선 이어폰 체험단',
    brand: '사운드랩',
    product_id: 12,
    image_url: 'https://img.example/12.jpg',
    recruit_count: 100,
    application_count: 1234,
    remaining_days: 3,
    apply_deadline: new Date('2026-10-21T14:59:59Z'), // 10/21 23:59:59 KST
    first_seen_at: new Date('2026-10-18T00:00:00Z'),
    last_seen_at: new Date('2026-10-18T00:00:00Z'),
    detail: null,
    score: 8.5,
    reason: '관심 품목이고 경쟁률이 낮아요',
    skip_reason: null,
    revision: 2,
    review_chat_id: null,
    review_message_id: null,
    review_revision: null,
    reject_reason: null,
    applied_at: null,
    selected_at: null,
    result_at: null,
    review_deadline: null,
    intake_message_id: null,
    memo: null,
    draft_text: null,
    regen_seq: 0,
    posted_at: null,
    created_at: new Date('2026-10-18T00:00:00Z'),
    updated_at: new Date('2026-10-18T00:00:00Z'),
    ...over,
  }
}

const NOW = new Date('2026-10-18T03:00:00Z') // 10/18 12:00 KST

describe('formatCampaignCard', () => {
  it('shows title, brand, counts, competition, D-n and instruction', () => {
    const text = formatCampaignCard(campaign(), NOW, TZ)
    expect(text).toContain('#12 무선 이어폰 체험단')
    expect(text).toContain('사운드랩')
    expect(text).toContain('모집 100명 · 신청 1,234명 (경쟁률 12.3:1)')
    expect(text).toContain('마감 D-3 (추정)')
    expect(text).toContain('⭐ 8.5 · 관심 품목이고 경쟁률이 낮아요')
    expect(text).toContain('📱 폰 카톡에서 열어 신청한 뒤 ✅ 신청함을 눌러주세요')
  })
  it('leaves out what is unknown', () => {
    const text = formatCampaignCard(
      campaign({
        brand: null,
        recruit_count: null,
        application_count: null,
        apply_deadline: null,
        score: null,
        reason: null,
      }),
      NOW,
      TZ,
    )
    expect(text).not.toMatch(/모집|신청 \d|마감|⭐/)
    expect(formatCampaignCard(campaign({ application_count: null }), NOW, TZ)).toContain(
      '모집 100명',
    )
    expect(formatCampaignCard(campaign({ recruit_count: null }), NOW, TZ)).toContain(
      '신청 1,234명\n',
    )
    expect(formatCampaignCard(campaign({ recruit_count: null }), NOW, TZ)).not.toContain('(경쟁률')
  })
  it('fits a 1024-char photo caption even with huge fields', () => {
    const text = formatCampaignCard(
      campaign({ title: '가'.repeat(900), brand: '나'.repeat(900), reason: '다'.repeat(2000) }),
      NOW,
      TZ,
    )
    expect([...text].length).toBeLessThanOrEqual(1024)
  })
  it('counts D-n by KST calendar day across midnight', () => {
    const deadline = new Date('2026-10-21T14:59:59Z') // 10/21 23:59 KST
    expect(daysUntil(deadline, new Date('2026-10-17T14:59:00Z'), TZ)).toBe(4) // 10/17 23:59 KST
    expect(daysUntil(deadline, new Date('2026-10-17T15:00:00Z'), TZ)).toBe(3) // 10/18 00:00 KST
    expect(daysUntil(deadline, new Date('2026-10-21T15:00:00Z'), TZ)).toBe(-1)
    expect(formatDday(0)).toBe('D-day')
    expect(formatDday(-2)).toBe('D+2')
  })
})

describe('buttons', () => {
  it('card buttons: url, applied and pass bound to the revision', () => {
    const [open, applied, pass] = campaignCardButtons(campaign())
    expect(open).toEqual({ text: '📱 선물하기에서 열기', url: 'https://gift.kakao.com/product/12' })
    expect(applied && 'callback' in applied && encodeCampaignCallback(applied.callback)).toBe(
      'camp:applied:12:2',
    )
    expect(pass && 'callback' in pass && encodeCampaignCallback(pass.callback)).toBe(
      'camp:pass:12:2',
    )
  })
  it('reject reasons: one per reason plus cancel, all bound to the revision', () => {
    const data = rejectReasonButtons(campaign()).map((b) =>
      'callback' in b ? encodeCampaignCallback(b.callback) : b.url,
    )
    expect(data).toEqual([
      ...Object.keys(CAMPAIGN_REJECT_REASONS).map((k) => `camp:passr:12:2:${k}`),
      'camp:passc:12:2',
    ])
    expect(data.every((d) => d.length <= 64)).toBe(true)
  })
})

describe('judgeCampaignPress', () => {
  const card = {
    status: 'PENDING_REVIEW' as const,
    review_message_id: 100,
    revision: 2,
    review_revision: 2,
  }
  it('accepts the current card and revision', () => {
    expect(judgeCampaignPress(card, { action: 'applied', revision: 2 }, 100)).toBe('ok')
  })
  it('refuses another message, an old revision or a finished campaign', () => {
    expect(judgeCampaignPress(card, { action: 'applied', revision: 2 }, 99)).toBe('stale')
    expect(judgeCampaignPress(card, { action: 'pass', revision: 1 }, 100)).toBe('stale')
    expect(
      judgeCampaignPress({ ...card, revision: 3 }, { action: 'passr', revision: 2 }, 100),
    ).toBe('stale')
    expect(
      judgeCampaignPress({ ...card, status: 'APPLIED' }, { action: 'applied', revision: 2 }, 100),
    ).toBe('stale')
    expect(judgeCampaignPress(card, { action: 'passc', revision: 2 }, undefined)).toBe('stale')
  })
  it('does not bind result buttons to a card', () => {
    const applied = { ...card, status: 'APPLIED' as const }
    expect(judgeCampaignPress(applied, { action: 'sel', revision: 0 }, 555)).toBe('ok')
    expect(judgeCampaignPress(applied, { action: 'unsel', revision: 0 }, 555)).toBe('ok')
  })
  it('reports a missing campaign', () => {
    expect(judgeCampaignPress(null, { action: 'sel', revision: 0 }, 1)).toBe('not-found')
  })
})

describe('parseDueDate', () => {
  const now = new Date('2026-10-18T03:00:00Z') // 10/18 KST
  const end = (d: string) => new Date(`${d}T14:59:00.000Z`) // 23:59 KST
  it.each([
    ['10/30', '2026-10-30'],
    ['10-30', '2026-10-30'],
    ['10.30', '2026-10-30'],
    ['1/5', '2027-01-05'], // already past this year -> next year
    ['10/18', '2026-10-18'], // today still counts
    ['10/17', '2027-10-17'],
    ['2026-10-30', '2026-10-30'],
    ['2026/11/2', '2026-11-02'],
    ['2026.12.31', '2026-12-31'],
    ['2025-01-01', '2025-01-01'], // an explicit year is kept
    ['  10/30 ', '2026-10-30'],
  ])('%s', (input, day) => {
    expect(parseDueDate(input, now, TZ)).toEqual(end(day))
  })
  it.each(['', 'abc', '1030', '13/1', '10/32', '2/30', '2026-02-30', '10', '10/30/2026'])(
    'rejects %j',
    (input) => {
      expect(parseDueDate(input, now, TZ)).toBeNull()
    },
  )
  it('rolls Feb 29 to the next leap year only when valid', () => {
    expect(parseDueDate('2/29', new Date('2027-03-01T00:00:00Z'), TZ)).toEqual(end('2028-02-29'))
  })
})

describe('formatActiveCampaigns', () => {
  it('says so when empty', () => {
    expect(formatActiveCampaigns([], NOW, TZ)).toMatch(/없어요/)
  })
  it('groups by stage with D-n and a /due hint', () => {
    const text = formatActiveCampaigns(
      [
        campaign({ id: 1, title: 'A' }),
        campaign({ id: 2, title: 'B', status: 'APPLIED' }),
        campaign({ id: 3, title: 'C', status: 'SELECTED', review_deadline: null }),
        campaign({
          id: 4,
          title: 'D',
          status: 'SELECTED',
          review_deadline: new Date('2026-10-20T14:59:00Z'),
        }),
        campaign({ id: 5, title: 'E', status: 'DRAFT_REVIEW', review_deadline: null }),
      ],
      NOW,
      TZ,
    )
    expect(text).toContain('신청 대기 (1)\n#1 [선물하기] A · D-3')
    expect(text).toContain('결과 대기 (1)\n#2 [선물하기] B · D-3')
    expect(text).toContain('#3 [선물하기] C · 기한 모름 (/due 3 10/30)')
    expect(text).toContain('#4 [선물하기] D · D-2')
    expect(text).not.toMatch(/#4 \[선물하기\] D.*\/due/)
    expect(text).toContain('초안 검수 (1)\n#5 [선물하기] E')
  })
})

describe('help', () => {
  it('registers camps and due', () => {
    expect(CAMPAIGN_BOT_COMMANDS.map((c) => c.command)).toEqual(['camps', 'due'])
    expect(CAMPAIGN_HELP_LINES.join('\n')).toContain('/due')
  })
})

const musinsaCampaign = (over: Partial<Campaign> = {}) =>
  campaign({
    source: 'musinsa',
    url: 'https://www.musinsa.com/preuser/events/38933',
    title: '후드 집업',
    recruit_count: null,
    application_count: null,
    detail: {
      campaignId: 38933,
      brandName: '브랜드',
      representativeGoods: { goodsName: '후드 집업', price: 129000 },
      goodsCount: 1,
      contentType: 'VIDEO',
    },
    ...over,
  })

describe('source-aware cards', () => {
  it('gift card keeps competition and the phone instruction with a source label', () => {
    const text = formatCampaignCard(campaign(), NOW, TZ)
    expect(text).toContain('[선물하기] #12')
    expect(text).toContain('경쟁률 12.3:1')
    expect(text).not.toContain('정가')
  })
  it('Musinsa card shows price, review format and the PC instruction', () => {
    const text = formatCampaignCard(musinsaCampaign(), NOW, TZ)
    expect(text).toContain('[무신사] #12 후드 집업')
    expect(text).toContain('정가 129,000원')
    expect(text).toContain('📹 영상 리뷰')
    expect(text).toContain('💻 PC에서 열어 신청한 뒤 ✅ 신청함을 눌러주세요')
    expect(text).not.toMatch(/모집|📱/)
    // Musinsa gives the exact end time, so its deadline is not marked as an estimate.
    expect(text).toContain('마감 D-')
    expect(text).not.toContain('추정')
    const image = formatCampaignCard(
      musinsaCampaign({ detail: { contentType: 'IMAGE', representativeGoods: { price: 1000 } } }),
      NOW,
      TZ,
    )
    expect(image).toContain('📷 사진 리뷰')
  })
  it('Musinsa card without detail still renders and fits a caption', () => {
    expect(formatCampaignCard(musinsaCampaign({ detail: null }), NOW, TZ)).toContain('[무신사]')
    const huge = formatCampaignCard(
      musinsaCampaign({
        title: '가'.repeat(900),
        brand: '나'.repeat(900),
        reason: '다'.repeat(2000),
      }),
      NOW,
      TZ,
    )
    expect([...huge].length).toBeLessThanOrEqual(1024)
  })
  it('url button text follows the source', () => {
    const [gift] = campaignCardButtons(campaign())
    const [musinsa, applied] = campaignCardButtons(musinsaCampaign())
    expect(gift).toMatchObject({ text: '📱 선물하기에서 열기' })
    expect(musinsa).toEqual({
      text: '💻 무신사에서 열기',
      url: 'https://www.musinsa.com/preuser/events/38933',
    })
    expect(applied && 'callback' in applied && applied.callback.action).toBe('applied')
  })
  it('/camps shows the source label', () => {
    const text = formatActiveCampaigns([campaign(), musinsaCampaign({ id: 13 })], NOW, TZ)
    expect(text).toContain('#12 [선물하기]')
    expect(text).toContain('#13 [무신사]')
  })
  it('help mentions both sources', () => {
    expect(CAMPAIGN_HELP_LINES.join('\n')).toContain('무신사에서 열기')
  })
})
