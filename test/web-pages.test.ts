import { describe, expect, it } from 'vitest'
import type { Campaign } from '../src/campaigns/types.ts'
import type { CampaignDetailData, CampaignListRow, OverviewData } from '../src/web/data.ts'
import { esc, extLink, IMAGE_HOSTS, isAllowedImageUrl, isHttpUrl } from '../src/web/html.ts'
import {
  formatCompetition,
  renderCampaignDetail,
  renderCampaignList,
  renderOverview,
  renderPosts,
} from '../src/web/pages.ts'

const ctx = { now: new Date('2026-10-18T03:00:00Z'), tz: 'Asia/Seoul' }

describe('escaping', () => {
  it('escapes markup and quotes', () => {
    expect(esc(`<script>alert("x")</script> 'a' & b`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;a&#39; &amp; b',
    )
  })
  it('keeps quotes from breaking out of attributes', () => {
    const html = extLink('https://a.example/?q="><img src=x onerror=alert(1)>')
    expect(html).not.toContain('"><img')
    expect(html).toContain('rel="noreferrer noopener"')
  })
  it('does not link non-http(s) URLs', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,x')).toBe(false)
    expect(isHttpUrl('/relative')).toBe(false)
    expect(extLink('javascript:alert(1)')).not.toContain('<a ')
    expect(extLink('https://ok.example/x')).toContain('<a href="https://ok.example/x"')
  })
})

const overview = (over: Partial<OverviewData> = {}): OverviewData => ({
  posts: { pendingReview: 2, scheduled: [], published24h: 1, failed: 0 },
  campaigns: {
    counts: { PENDING_REVIEW: 3, APPLIED: 2, SELECTED: 1, POSTED: 9 },
    lastCollectedAt: new Date('2026-10-18T02:30:00Z'),
    lastSeenCount: 42,
    postedLast30d: 4,
    bySource: { 'kakao-gift': { PENDING_REVIEW: 2, APPLIED: 2 }, musinsa: { PENDING_REVIEW: 1 } },
  },
  ...over,
})

describe('renderOverview', () => {
  it('shows campaign counts, the last collection and no worker heartbeat', () => {
    const html = renderOverview(overview(), ctx)
    expect(html).toContain('<b>3</b><span>검수 대기')
    expect(html).toContain('<b>2</b><span>신청함·결과 대기')
    expect(html).toContain('<b>1</b><span>선정·리뷰 전')
    expect(html).toContain('<b>0</b><span>리뷰 초안')
    expect(html).toContain('<b>4</b><span>최근 30일 리뷰 완료')
    expect(html).toContain('2026-10-18 11:30')
    expect(html).toContain('30분 전')
    expect(html).toContain('체험단 42건')
    expect(html).toContain('발행 예정인 글이 없어요')
    expect(html).not.toContain('로컬 워커')
    expect(html).toContain('http-equiv="refresh"')
  })
  it('handles a database that was never collected', () => {
    const html = renderOverview(
      overview({
        campaigns: {
          counts: {},
          lastCollectedAt: null,
          lastSeenCount: 0,
          postedLast30d: 0,
          bySource: {},
        },
      }),
      ctx,
    )
    expect(html).toContain('아직 수집한 체험단이 없어요')
  })
  it('escapes scheduled post text', () => {
    const html = renderOverview(
      overview({
        posts: {
          pendingReview: 0,
          published24h: 0,
          failed: 0,
          scheduled: [{ id: 1, text: '<b>x</b>', scheduled_at: new Date('2026-10-18T05:00:00Z') }],
        },
      }),
      ctx,
    )
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('formatCompetition', () => {
  it('formats applicants per slot, or a dash when unknown', () => {
    expect(formatCompetition({ application_count: 123_400, recruit_count: 100 })).toBe('1,234:1')
    expect(formatCompetition({ application_count: 25, recruit_count: 10 })).toBe('2.5:1')
    expect(formatCompetition({ application_count: null, recruit_count: 10 })).toBe('-')
    expect(formatCompetition({ application_count: 5, recruit_count: 0 })).toBe('-')
  })
})

const listRow = (over: Partial<CampaignListRow> = {}): CampaignListRow => ({
  id: 7,
  source: 'kakao-gift',
  title: '<i>이어폰</i> 체험',
  brand: '<b>브랜드</b>',
  status: 'PENDING_REVIEW',
  recruit_count: 10,
  application_count: 5000,
  apply_deadline: new Date('2026-10-20T09:00:00Z'),
  review_deadline: null,
  score: 82,
  updated_at: new Date('2026-10-18T01:00:00Z'),
  ...over,
})

describe('renderCampaignList', () => {
  it('shows label, competition, estimated D-n, and escapes title and brand', () => {
    const html = renderCampaignList([listRow()], 'active', ctx)
    expect(html).toContain('D-2')
    expect(html).toContain('추정')
    expect(html).toContain('500:1')
    expect(html).toContain('검수 대기</span>')
    expect(html).toContain('href="/campaigns/7"')
    expect(html).toContain('&lt;i&gt;이어폰&lt;/i&gt;')
    expect(html).toContain('&lt;b&gt;브랜드&lt;/b&gt;')
    expect(html).not.toContain('<b>브랜드</b>')
  })
  it('uses the review deadline, unestimated, for SELECTED', () => {
    const html = renderCampaignList(
      [
        listRow({
          status: 'SELECTED',
          review_deadline: new Date('2026-10-25T09:00:00Z'),
          application_count: null,
        }),
      ],
      'all',
      ctx,
    )
    expect(html).toContain('D-7')
    expect(html).not.toContain('추정')
    expect(html).toContain('선정</span>')
    expect(html).toContain('<td data-label="경쟁률">-</td>')
  })
  it('marks the active filter chip, offers the new statuses and handles empty', () => {
    const html = renderCampaignList([], 'APPLIED', ctx)
    expect(html).toContain('해당하는 체험단이 없어요')
    expect(html).toContain('href="/campaigns?status=APPLIED" class="on"')
    for (const s of ['SELECTED', 'DRAFT_REVIEW', 'NOT_SELECTED', 'POSTED']) {
      expect(html).toContain(`href="/campaigns?status=${s}"`)
    }
    expect(html).not.toContain('APPLY_FAILED')
  })
})

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: 9,
  source: 'kakao-gift',
  external_id: 'x',
  url: 'https://gift.kakao.com/product/123',
  url_hash: 'h',
  status: 'DRAFT_REVIEW',
  title: '<u>수분 크림</u> 체험',
  brand: '브랜드A',
  product_id: 123,
  image_url: 'https://st.kakaocdn.net/product/a.png',
  recruit_count: 20,
  application_count: 3000,
  remaining_days: 3,
  apply_deadline: new Date('2026-10-21T14:59:59Z'),
  first_seen_at: new Date('2026-10-10T00:00:00Z'),
  last_seen_at: new Date('2026-10-18T02:00:00Z'),
  detail: null,
  score: 71,
  reason: '평가 <이유>',
  shortlisted_at: null,
  skip_reason: null,
  revision: 0,
  review_chat_id: null,
  review_message_id: null,
  review_revision: null,
  reject_reason: null,
  applied_at: new Date('2026-10-11T00:00:00Z'),
  selected_at: new Date('2026-10-15T00:00:00Z'),
  result_at: new Date('2026-10-15T00:00:00Z'),
  review_deadline: new Date('2026-10-18T10:00:00Z'),
  intake_message_id: null,
  memo: '메모 <script>x</script>',
  draft_text: '첫 줄\n둘째 줄',
  regen_seq: 0,
  posted_at: null,
  created_at: new Date('2026-10-10T00:00:00Z'),
  updated_at: new Date('2026-10-18T00:00:00Z'),
  ...over,
})

describe('renderCampaignDetail', () => {
  const data: CampaignDetailData = {
    campaign: campaign(),
    reminders: [{ kind: 'review-d3', sent_at: new Date('2026-10-15T00:00:00Z') }],
  }
  it('renders fields, competition, draft and escapes everything', () => {
    const html = renderCampaignDetail(data, ctx)
    expect(html).toContain('D-day')
    expect(html).toContain('150:1')
    expect(html).toContain('3,000')
    expect(html).toContain('신청 마감 (추정)')
    expect(html).toContain('review-d3')
    expect(html).toContain('첫 줄\n둘째 줄')
    expect(html).toContain('&lt;u&gt;수분 크림&lt;/u&gt;')
    expect(html).toContain('평가 &lt;이유&gt;')
    expect(html).not.toContain('<script>x')
    expect(html).toContain('href="https://gift.kakao.com/product/123"')
    expect(html).toContain('선물하기에서 열기')
    expect(html).not.toMatch(/revu|블로그|하트비트|스크린샷/)
  })
  it('embeds allowlisted https thumbnails only', () => {
    expect(renderCampaignDetail(data, ctx)).toContain(
      '<img src="https://st.kakaocdn.net/product/a.png"',
    )
    for (const image_url of [
      'http://st.kakaocdn.net/a.png',
      'https://evil.example/a.png',
      'https://st.kakaocdn.net.evil.example/a.png',
      'https://user:pw@st.kakaocdn.net/a.png',
      'javascript:alert(1)',
      null,
    ]) {
      const html = renderCampaignDetail({ ...data, campaign: campaign({ image_url }) }, ctx)
      expect(html).not.toContain('<img')
    }
  })
  it('shows dashes and empty states for a bare collected campaign', () => {
    const html = renderCampaignDetail(
      {
        campaign: campaign({
          status: 'COLLECTED',
          brand: null,
          product_id: null,
          recruit_count: null,
          application_count: null,
          remaining_days: null,
          apply_deadline: null,
          review_deadline: null,
          memo: null,
          draft_text: null,
          applied_at: null,
          selected_at: null,
          result_at: null,
        }),
        reminders: [],
      },
      ctx,
    )
    expect(html).toContain('수집됨')
    expect(html).toContain('아직 초안이 없어요')
    expect(html).toContain('메모가 없어요')
  })
})

describe('isAllowedImageUrl', () => {
  it('accepts only https on the allowlisted hosts', () => {
    expect(isAllowedImageUrl('https://t1.daumcdn.net/a.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://gift-s.kakaocdn.net/a.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://t1.daumcdn.net:8443/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('//t1.daumcdn.net/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('')).toBe(false)
  })
})

describe('renderPosts', () => {
  it('renders insights, truncation and the empty state', () => {
    expect(renderPosts([], ctx)).toContain('글이 아직 없어요')
    const html = renderPosts(
      [
        {
          id: 1,
          status: 'PUBLISHED',
          text: 'x'.repeat(100),
          scheduled_at: null,
          published_at: new Date('2026-10-17T00:00:00Z'),
          views: 10,
          likes: 2,
          replies: null,
        },
      ],
      ctx,
    )
    expect(html).toContain(`${'x'.repeat(80)}…`)
    expect(html).toContain('조회 10 · 좋아요 2 · 답글 -')
  })
})

describe('sources in the dashboard', () => {
  it('allows Musinsa image hosts, https only', () => {
    expect(IMAGE_HOSTS).toContain('image.msscdn.net')
    expect(isAllowedImageUrl('https://image.msscdn.net/thumbnails/images/goods_img/a.jpg')).toBe(
      true,
    )
    expect(isAllowedImageUrl('http://image.msscdn.net/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('https://image.msscdn.net.evil.example/a.jpg')).toBe(false)
  })
  it('list shows a source column and source filter chips that keep the status', () => {
    const html = renderCampaignList(
      [
        listRow(),
        listRow({ id: 8, source: 'musinsa', recruit_count: null, application_count: null }),
      ],
      'APPLIED',
      ctx,
      'musinsa',
    )
    expect(html).toContain('<th>출처</th>')
    expect(html).toContain('<td data-label="출처">선물하기</td>')
    expect(html).toContain('<td data-label="출처">무신사</td>')
    expect(html).toContain(
      'href="/campaigns?status=APPLIED&amp;source=musinsa" class="on"'.replace('&amp;', '&'),
    )
    expect(html).toContain('href="/campaigns?status=APPLIED">모든 출처')
    expect(html).toContain('href="/campaigns?status=APPLIED&source=kakao-gift">선물하기')
    expect(html).toContain('href="/campaigns?status=SELECTED&source=musinsa"')
  })
  it('overview shows per-source counts linking to the filter', () => {
    const html = renderOverview(overview(), ctx)
    expect(html).toContain('href="/campaigns?source=kakao-gift"')
    expect(html).toContain('<b>4</b><span>선물하기 진행 중 (전체 4)')
    expect(html).toContain('<b>1</b><span>무신사 진행 중 (전체 1)')
  })
  it('detail shows category, price and dates for Musinsa', () => {
    const html = renderCampaignDetail(
      {
        campaign: campaign({
          source: 'musinsa',
          url: 'https://www.musinsa.com/preuser/events/38933',
          image_url: 'https://image.msscdn.net/thumbnails/images/goods_img/a.jpg',
          recruit_count: null,
          application_count: null,
          detail: {
            products: [
              {
                isRepresentative: true,
                prices: { normalPrice: { value: 129000 }, salePrice: { value: 89000 } },
              },
            ],
            eventCategory: 'FASHION_ACCESSORY',
            winnerDrawDate: '2026-10-27',
            reviewStartDate: '2026-10-31',
            reviewEndDate: '2026-11-14',
          },
        }),
        reminders: [],
      },
      ctx,
    )
    expect(html).toContain('<dt>품목</dt><dd>패션 소품</dd>')
    expect(html).toContain('<dt>정가</dt><dd>129,000원 → 89,000원</dd>')
    expect(html).toContain('<dt>발표일</dt><dd>2026-10-27</dd>')
    expect(html).toContain('<dt>리뷰 기간</dt><dd>2026-10-31 ~ 2026-11-14</dd>')
    expect(html).toContain('무신사에서 열기')
    expect(html).toContain('<img src="https://image.msscdn.net/')
    expect(html).toContain('<dt>신청자</dt>')
  })
})
