import type {
  CampaignDetailResponse,
  CampaignRow,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
} from '../lib/types.ts'

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const days = (d: number) => hours(d * 24)

export const overviewFixture: OverviewResponse = {
  posts: {
    pendingReview: 2,
    scheduled: [
      {
        id: 41,
        text: 'Claude Code가 새 에이전트 SDK를 공개함. 서브에이전트를 코드에서 바로 정의할 수 있음',
        scheduled_at: hours(3),
      },
      { id: 42, text: 'Vite 7 나왔음. Node 20.19 이상 필요함', scheduled_at: hours(9) },
    ],
    published24h: 3,
    failed: 1,
  },
  campaigns: {
    counts: { PENDING_REVIEW: 4, APPLIED: 6, SELECTED: 2, DRAFT_REVIEW: 1, POSTED: 12 },
    lastCollectedAt: hours(-2),
    lastSeenCount: 475,
    postedLast30d: 5,
    bySource: {
      'kakao-gift': { PENDING_REVIEW: 3, APPLIED: 4, SELECTED: 1, POSTED: 9, SKIPPED: 300 },
      musinsa: { PENDING_REVIEW: 1, APPLIED: 2, SELECTED: 1, DRAFT_REVIEW: 1, POSTED: 3 },
    },
  },
}

const baseCampaign = {
  external_id: 'x',
  url_hash: 'h',
  revision: 1,
  review_chat_id: null,
  review_message_id: null,
  review_revision: null,
  intake_message_id: null,
  regen_seq: 0,
  shortlisted_at: null,
  detail: null,
  first_seen_at: days(-5),
  last_seen_at: hours(-2),
  created_at: days(-5),
  updated_at: hours(-2),
}

export const campaignRowsFixture: CampaignRow[] = [
  {
    id: 101,
    source: 'kakao-gift',
    title: '[체험단] 프리미엄 견과 선물세트 100명 모집',
    brand: '넛츠앤모어',
    status: 'PENDING_REVIEW',
    recruit_count: 100,
    application_count: 2345,
    apply_deadline: days(1),
    review_deadline: null,
    score: 82,
    updated_at: hours(-1),
    next_deadline: { at: days(1), kind: 'apply', estimated: true },
    competition: 23.45,
  },
  {
    id: 102,
    source: 'musinsa',
    title: '[+2] 데일리 후드 집업',
    brand: '무탠다드',
    status: 'APPLIED',
    recruit_count: null,
    application_count: null,
    apply_deadline: days(3),
    review_deadline: null,
    score: 74,
    updated_at: hours(-5),
    next_deadline: { at: days(3), kind: 'apply', estimated: false },
    competition: null,
  },
  {
    id: 103,
    source: 'kakao-gift',
    title: '비건 핸드크림 3종 체험단',
    brand: null,
    status: 'SELECTED',
    recruit_count: 30,
    application_count: 120,
    apply_deadline: days(-4),
    review_deadline: days(5),
    score: 65,
    updated_at: hours(-20),
    next_deadline: { at: days(5), kind: 'review', estimated: false },
    competition: 4,
  },
  {
    id: 104,
    source: 'kakao-gift',
    title: '종료된 체험단',
    brand: '옛브랜드',
    status: 'POSTED',
    recruit_count: 10,
    application_count: 10,
    apply_deadline: days(-20),
    review_deadline: null,
    score: null,
    updated_at: days(-3),
    next_deadline: null,
    competition: 1,
  },
]

export const campaignListFixture = (status: string, source: string | null) => ({
  filter: { status, source },
  rows: campaignRowsFixture.filter((r) => !source || r.source === source),
})

export const campaignDetailFixture = (id: number): CampaignDetailResponse | null => {
  const row = campaignRowsFixture.find((r) => r.id === id)
  if (!row) return null
  const musinsa = row.source === 'musinsa'
  return {
    campaign: {
      ...baseCampaign,
      id: row.id,
      source: row.source,
      url: musinsa
        ? 'https://www.musinsa.com/preuser/events/9'
        : 'https://gift.kakao.com/product/1',
      status: row.status as CampaignDetailResponse['campaign']['status'],
      title: row.title,
      brand: row.brand,
      product_id: musinsa ? null : 12345,
      image_url: musinsa
        ? 'https://image.msscdn.net/images/goods_img/1.jpg'
        : 'https://st.kakaocdn.net/product/gift/1.jpg',
      recruit_count: row.recruit_count,
      application_count: row.application_count,
      remaining_days: musinsa ? null : 1,
      apply_deadline: row.apply_deadline,
      detail: musinsa
        ? {
            products: [
              {
                uniqueId: '7529016',
                isRepresentative: true,
                prices: { normalPrice: { value: 59000 }, salePrice: { value: 41300 } },
              },
              { uniqueId: '7529017', isRepresentative: false },
              { uniqueId: '7529018', isRepresentative: false },
            ],
            eventCategory: 'FASHION_ACCESSORY',
            winnerDrawDate: '2026-10-27',
            reviewStartDate: '2026-10-31',
            reviewEndDate: '2026-11-14',
          }
        : null,
      score: row.score,
      reason: row.score ? '관심 카테고리이고 경쟁률이 보통 수준임' : null,
      skip_reason: null,
      reject_reason: null,
      applied_at: row.status === 'PENDING_REVIEW' ? null : days(-2),
      selected_at: row.status === 'SELECTED' ? days(-1) : null,
      result_at: row.status === 'SELECTED' ? days(-1) : null,
      review_deadline: row.review_deadline,
      memo:
        row.status === 'SELECTED' ? '향이 은은하고 보습이 좋았음\n둘째 날부터 효과를 느낌' : null,
      draft_text:
        row.status === 'SELECTED'
          ? '체험단으로 받아서 써봤음.\n\n향이 은은하고 보습력이 좋음.'
          : null,
      posted_at: null,
    },
    reminders: row.status === 'SELECTED' ? [{ kind: 'review-d3', sent_at: hours(-10) }] : [],
  }
}

export const postsFixture: PostListResponse = {
  rows: [
    {
      id: 41,
      status: 'SCHEDULED',
      text: 'Claude Code가 새 에이전트 SDK를 공개함. 서브에이전트를 코드에서 바로 정의할 수 있음',
      scheduled_at: hours(3),
      published_at: null,
      views: null,
      likes: null,
      replies: null,
      origin: 'news',
    },
    {
      id: 40,
      status: 'PUBLISHED',
      text: '지난주 만료된 글 다시 올림. TypeScript 5.9 요약',
      scheduled_at: hours(-20),
      published_at: hours(-20),
      views: 1820,
      likes: 31,
      replies: 4,
      origin: 'revived',
    },
    {
      id: 39,
      status: 'PUBLISHED',
      text: '이번 주 AI 소식 묶음. 1) 모델 가격 인하 2) 새 벤치마크 3) 오픈소스 에이전트',
      scheduled_at: hours(-44),
      published_at: hours(-44),
      views: 960,
      likes: 12,
      replies: 0,
      origin: 'digest',
    },
    {
      id: 38,
      status: 'FAILED',
      text: '발행에 실패한 글',
      scheduled_at: hours(-60),
      published_at: null,
      views: null,
      likes: null,
      replies: null,
      origin: 'news',
    },
  ],
}

export const insightsFixture = (nDays: number): InsightsResponse => {
  const daily = Array.from({ length: nDays }, (_, i) => {
    const d = new Date(Date.now() - (nDays - 1 - i) * 86_400_000)
    return {
      date: d.toISOString().slice(0, 10),
      posts: (i % 3) + 1,
      views: 400 + ((i * 137) % 900),
      likes: 5 + ((i * 7) % 30),
      replies: (i * 3) % 6,
    }
  })
  return {
    days: nDays,
    daily,
    top: [
      {
        id: 40,
        text: '지난주 만료된 글 다시 올림. TypeScript 5.9 요약',
        published_at: hours(-20),
        views: 1820,
        likes: 31,
        replies: 4,
        reposts: 2,
      },
      {
        id: 39,
        text: '이번 주 AI 소식 묶음',
        published_at: hours(-44),
        views: 960,
        likes: 12,
        replies: 0,
        reposts: null,
      },
    ],
  }
}
