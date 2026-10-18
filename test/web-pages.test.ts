import { describe, expect, it } from 'vitest'
import type { Campaign } from '../src/campaigns/types.ts'
import type { CampaignDetailData, CampaignListRow, OverviewData } from '../src/web/data.ts'
import { esc, extLink, isHttpUrl } from '../src/web/html.ts'
import {
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
  campaignCounts: { PENDING_REVIEW: 3, APPROVED: 1, APPLYING: 1, POSTED: 4 },
  heartbeats: [],
  ...over,
})

describe('renderOverview', () => {
  it('sums bucketed statuses and shows empty states', () => {
    const html = renderOverview(overview(), ctx)
    expect(html).toContain('<b>3</b><span>검수 대기')
    expect(html).toContain('<b>2</b><span>신청 대기/진행')
    expect(html).toContain('발행 예정인 글이 없어요')
    expect(html).toContain('하트비트가 아직 없어요')
    expect(html).toContain('http-equiv="refresh"')
  })
  it('warns when the heartbeat is older than 30 minutes', () => {
    const stale = renderOverview(
      overview({ heartbeats: [{ role: 'local', seen_at: new Date('2026-10-18T02:00:00Z') }] }),
      ctx,
    )
    expect(stale).toContain('badge warn')
    const fresh = renderOverview(
      overview({ heartbeats: [{ role: 'local', seen_at: new Date('2026-10-18T02:50:00Z') }] }),
      ctx,
    )
    expect(fresh).not.toContain('badge warn')
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

const listRow = (over: Partial<CampaignListRow> = {}): CampaignListRow => ({
  id: 7,
  title: '<i>이어폰</i> 체험',
  status: 'PENDING_REVIEW',
  reward_won: 59000,
  apply_deadline: new Date('2026-10-20T09:00:00Z'),
  announce_at: null,
  review_deadline: null,
  score: 82,
  found_in: '체험단방',
  updated_at: new Date('2026-10-18T01:00:00Z'),
  offer: null,
  ...over,
})

describe('renderCampaignList', () => {
  it('shows D-n, label, and escapes the title', () => {
    const html = renderCampaignList([listRow()], 'active', ctx)
    expect(html).toContain('D-2')
    expect(html).toContain('href="/campaigns/7"')
    expect(html).toContain('&lt;i&gt;이어폰&lt;/i&gt;')
    expect(html).toContain('59,000원')
  })
  it('marks the active filter chip and handles empty', () => {
    const html = renderCampaignList([], 'APPLIED', ctx)
    expect(html).toContain('해당하는 체험단이 없어요')
    expect(html).toContain('href="/campaigns?status=APPLIED" class="on"')
  })
})

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: 9,
  source: 'revu',
  external_id: 'x',
  url: 'https://www.revu.net/campaign/9',
  url_hash: 'h',
  found_in: null,
  status: 'DRAFT_FAILED',
  title: '맛집',
  type: 'visit',
  category: null,
  reward_won: null,
  recruit_count: 5,
  apply_deadline: null,
  announce_at: null,
  review_deadline: new Date('2026-10-18T10:00:00Z'),
  keywords: ['a', 'b'],
  detail: null,
  score: null,
  reason: null,
  skip_reason: null,
  apply_message: null,
  revision: 0,
  review_chat_id: null,
  review_message_id: null,
  review_revision: null,
  reject_reason: null,
  claim_seq: 0,
  attempts: 2,
  last_error: '<script>boom</script>',
  screenshot_path: null,
  applied_at: null,
  selected_at: null,
  received_at: null,
  intake_message_id: null,
  memo: null,
  draft_title: '초안 제목',
  draft_body: '첫 줄\n둘째 줄',
  regen_seq: 0,
  draft_saved_at: null,
  blog_url: 'javascript:alert(1)',
  posted_at: null,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-18T00:00:00Z'),
  ...over,
})

describe('renderCampaignDetail', () => {
  const data: CampaignDetailData = {
    campaign: campaign(),
    reminders: [{ kind: 'review-d3', sent_at: new Date('2026-10-15T00:00:00Z') }],
    photoCount: 3,
  }
  it('renders fields, escapes errors, never links javascript: urls', () => {
    const html = renderCampaignDetail(data, ctx)
    expect(html).toContain('D-day')
    expect(html).toContain('3장')
    expect(html).toContain('review-d3')
    expect(html).toContain('첫 줄\n둘째 줄')
    expect(html).not.toContain('<script>boom')
    expect(html).toContain('&lt;script&gt;boom')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="https://www.revu.net/campaign/9"')
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
