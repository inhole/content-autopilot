import type {
  AddTopicRequest,
  AddTopicResponse,
  AuthSessionResponse,
  CampaignDetailResponse,
  CampaignRow,
  InsightsResponse,
  OpsResponse,
  OpsRunResponse,
  OverviewResponse,
  PostDetailResponse,
  PostListResponse,
  QueuedResponse,
  RevivableResponse,
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
  draft_seq: 0,
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
    price: 49000,
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
    price: 59000,
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
    price: null,
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
    price: 32000,
  },
]

export const campaignListFixture = (status: string, source: string | null) => ({
  filter: { status, source },
  rows: campaignRowsFixture.filter((r) => !source || r.source === source),
})

const buildCampaignDetail = (id: number): CampaignDetailResponse | null => {
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
        : row.price != null
          ? {
              campaignId: `g${row.id}`,
              campaignTitle: row.title,
              price: { basic: row.price, selling: Math.round(row.price * 0.8) },
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

type MockCampaign = CampaignDetailResponse['campaign']
/** What the mock POSTs changed, so `npm run dev:mock` behaves like a live server. */
const campaignOverrides = new Map<number, Partial<MockCampaign>>()

export const campaignDetailFixture = (id: number): CampaignDetailResponse | null => {
  const detail = buildCampaignDetail(id)
  const over = campaignOverrides.get(id)
  if (detail && over) Object.assign(detail.campaign, over)
  return detail
}

/** Applies a campaign action to the mock state; 'stale' when the view was outdated. */
export function mockCampaignAction(
  id: number,
  name: string,
  body: unknown,
): CampaignDetailResponse | 'stale' | 'not_found' {
  const current = campaignDetailFixture(id)
  if (!current) return 'not_found'
  const c = current.campaign
  const b = (body ?? {}) as Record<string, unknown>
  const set = (patch: Partial<MockCampaign>) => {
    campaignOverrides.set(id, { ...campaignOverrides.get(id), ...patch })
    return campaignDetailFixture(id) as CampaignDetailResponse
  }
  const bump = { revision: c.revision + 1 }
  const draftFrom = (memo: string) =>
    `체험단으로 제품을 제공받아 작성한 솔직한 리뷰입니다.\n\n${memo.split('\n')[0]}. 써보니 만족스러웠음.`
  const outdated = (ok: boolean) => !ok
  switch (name) {
    case 'apply':
      return outdated(c.status === 'PENDING_REVIEW' && b.revision === c.revision)
        ? 'stale'
        : set({ status: 'APPLIED', applied_at: new Date().toISOString() })
    case 'reject':
      return outdated(c.status === 'PENDING_REVIEW' && b.revision === c.revision)
        ? 'stale'
        : set({ status: 'REJECTED', reject_reason: String(b.reason) })
    case 'result':
      return outdated(c.status === 'APPLIED')
        ? 'stale'
        : set({ status: b.selected ? 'SELECTED' : 'NOT_SELECTED' })
    case 'deadline':
      return outdated(c.status === b.status)
        ? 'stale'
        : set({ review_deadline: new Date(Date.now() + 7 * 86_400_000).toISOString() })
    case 'memo':
      return outdated(c.status === b.status && c.revision === b.revision)
        ? 'stale'
        : set({
            memo: String(b.memo),
            status: 'DRAFT_REVIEW',
            draft_text: draftFrom(String(b.memo)),
            ...bump,
          })
    case 'regenerate':
      return outdated(c.status === 'DRAFT_REVIEW' && c.revision === b.revision)
        ? 'stale'
        : set({ draft_text: draftFrom(c.memo ?? ''), ...bump })
    case 'draft':
      return outdated(c.status === 'DRAFT_REVIEW' && c.revision === b.revision)
        ? 'stale'
        : set({ draft_text: String(b.text), ...bump })
    case 'posted':
      return outdated(c.status === 'DRAFT_REVIEW' && c.revision === b.revision)
        ? 'stale'
        : set({ status: 'POSTED', posted_at: new Date().toISOString() })
    default:
      return 'not_found'
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
    ...[
      [51, 'PENDING_REVIEW', 'Cloudflare가 에이전트용 샌드박스 컨테이너를 공개함'],
      [52, 'PENDING_REVIEW', 'Postgres 18 정식 출시. 비동기 I/O가 들어갔음'],
      [61, 'EXPIRED', 'HTTP 캐시 헤더를 제대로 이해하는 방법. 결국 max-age와 ETag 두 개가 전부임'],
      [62, 'EXPIRED', '오늘 열린 컨퍼런스 키노트 요약. 신제품 세 개가 나왔음'],
      [63, 'EXPIRED', 'SQLite가 의외로 서버에서도 쓸 만한 이유'],
    ].map(([id, status, text]) => ({
      id: id as number,
      status: status as string,
      text: text as string,
      scheduled_at: null,
      published_at: null,
      views: null,
      likes: null,
      replies: null,
      origin: 'news' as const,
    })),
  ],
}

type MockPost = PostDetailResponse
const LIMITS: MockPost['limits'] = { text: 500, lastFollowup: 430, cta: '더 보고 싶으면 팔로우' }

const noRevive: MockPost['post']['revive'] = {
  verdict: null,
  reason: null,
  checked_at: null,
  revived_at: null,
  from_text: null,
}

function mockPostBase(
  id: number,
  status: MockPost['post']['status'],
  title: string,
  text: string,
  over: Partial<MockPost['post']> = {},
  parts: MockPost['parts'] = [],
): MockPost {
  return {
    post: {
      id,
      status,
      origin: 'news',
      text,
      angle: '직접 써 보면 체감이 큰 변화라는 쪽',
      source_url: `https://example.com/articles/${id}`,
      caveats: [],
      revision: 1,
      regen_seq: 0,
      scheduled_at: null,
      published_at: null,
      created_at: hours(-30),
      updated_at: hours(-2),
      reject_reason: null,
      attempts: 0,
      last_error: null,
      topic: { id: id + 500, title, url: `https://example.com/articles/${id}`, note: null, score: 8.2 },
      revive: noRevive,
      digest_post_id: null,
      ...over,
    },
    parts,
    limits: LIMITS,
  }
}

const part = (
  idx: number,
  text: string,
  over: Partial<MockPost['parts'][number]> = {},
): MockPost['parts'][number] => ({
  idx,
  text,
  status: 'PENDING',
  attempts: 0,
  last_error: null,
  link_url: null,
  ...over,
})

const buildMockPosts = () =>
  new Map<number, MockPost>(
    [
      mockPostBase(
        51,
        'PENDING_REVIEW',
        'Cloudflare 샌드박스 컨테이너',
        'Cloudflare가 에이전트용 샌드박스 컨테이너를 공개함. 코드를 격리해서 돌리는 용도라 에이전트가 만든 코드를 안전하게 실행할 수 있음',
        { caveats: ['가격은 아직 베타라 바뀔 수 있음'] },
      ),
      mockPostBase(
        52,
        'PENDING_REVIEW',
        'Postgres 18 출시',
        'Postgres 18 나왔음. 이번엔 비동기 I/O가 핵심임',
        {},
        [
          part(2, '디스크 읽기를 기다리지 않고 여러 요청을 한꺼번에 던질 수 있게 됐음. 순차 스캔이 특히 빨라진다고 함'),
          part(3, 'uuidv7도 기본 함수로 들어왔음. 정렬 가능한 id가 필요했던 사람한텐 반가운 소식임', {
            link_url: 'https://example.com/articles/52',
          }),
        ],
      ),
      mockPostBase(
        41,
        'SCHEDULED',
        'Claude Code 에이전트 SDK',
        'Claude Code가 새 에이전트 SDK를 공개함. 서브에이전트를 코드에서 바로 정의할 수 있음',
        { scheduled_at: hours(3), revision: 3 },
      ),
      mockPostBase(
        40,
        'PUBLISHED',
        'TypeScript 5.9',
        '지난주 만료된 글 다시 올림. TypeScript 5.9 요약',
        {
          origin: 'revived',
          scheduled_at: hours(-20),
          published_at: hours(-20),
          revive: {
            verdict: 'evergreen',
            reason: '버전 요약이라 시간이 지나도 유효함',
            checked_at: days(-3),
            revived_at: days(-1),
            from_text: '어제 TypeScript 5.9이 나왔음. 주요 변경점 정리했음',
          },
        },
      ),
      mockPostBase(
        39,
        'PUBLISHED',
        '이번 주 AI 소식 묶음',
        '이번 주 AI 소식 묶음. 세 가지만 골랐음',
        { origin: 'digest', scheduled_at: hours(-44), published_at: hours(-44) },
        [
          part(2, '1) 모델 가격이 또 내려갔음. 같은 성능이 절반 값임', {
            status: 'PUBLISHED',
            attempts: 1,
            link_url: 'https://example.com/a',
          }),
          part(3, '2) 새 벤치마크가 나왔는데 에이전트가 실제 업무를 얼마나 하는지 재는 쪽임', {
            status: 'FAILED',
            attempts: 3,
            last_error: 'Threads API 500: temporarily unavailable',
          }),
        ],
      ),
      mockPostBase(38, 'FAILED', '발행 실패', '발행에 실패한 글', {
        scheduled_at: hours(-60),
        attempts: 3,
        last_error: 'container ERROR: media could not be fetched',
      }),
      mockPostBase(
        61,
        'EXPIRED',
        'HTTP 캐시',
        'HTTP 캐시 헤더를 제대로 이해하는 방법. 결국 max-age와 ETag 두 개가 전부임',
        {
          revive: {
            verdict: 'evergreen',
            reason: '시간이 지나도 변하지 않는 개념 설명',
            checked_at: hours(-5),
            revived_at: null,
            from_text: null,
          },
        },
      ),
      mockPostBase(
        62,
        'EXPIRED',
        '컨퍼런스 키노트',
        '오늘 열린 컨퍼런스 키노트 요약. 신제품 세 개가 나왔음',
        {
          revive: {
            verdict: 'stale',
            reason: '"오늘" 행사 소식이라 지금 올리면 어색함',
            checked_at: hours(-5),
            revived_at: null,
            from_text: null,
          },
        },
      ),
      mockPostBase(63, 'EXPIRED', 'SQLite 서버', 'SQLite가 의외로 서버에서도 쓸 만한 이유'),
    ].map((p) => [p.post.id, p]),
  )

let mockPosts = buildMockPosts()

export const mockPostDetail = (id: number): MockPost | null => {
  const p = mockPosts.get(id)
  return p ? structuredClone(p) : null
}

/** The list overlays what the mock POSTs changed. */
export const mockPostsList = (): PostListResponse => ({
  rows: postsFixture.rows.map((r) => {
    const p = mockPosts.get(r.id)?.post
    return p
      ? {
          ...r,
          status: p.status,
          text: p.text,
          origin: p.origin,
          scheduled_at: p.scheduled_at,
          published_at: p.published_at,
        }
      : r
  }),
})

export const mockRevivable = (): RevivableResponse => ({
  rows: [...mockPosts.values()]
    .filter((m) => m.post.status === 'EXPIRED' && m.post.origin === 'news' && !m.post.revive.revived_at)
    .map(({ post: p }) => ({
      id: p.id,
      title: p.topic.title,
      text: p.text,
      source_url: p.source_url,
      created_at: p.created_at,
      verdict: p.revive.verdict,
      reason: p.revive.reason,
      checked_at: p.revive.checked_at,
    })),
})

/** Judges every unjudged expired draft (alternating), like the revive-check job. */
export function mockReviveCheck(): QueuedResponse {
  let n = 0
  for (const m of mockPosts.values()) {
    if (m.post.status !== 'EXPIRED' || m.post.revive.verdict) continue
    m.post.revive = {
      ...m.post.revive,
      verdict: n++ % 2 === 0 ? 'evergreen' : 'stale',
      reason: '모의 판정',
      checked_at: new Date().toISOString(),
    }
  }
  return { ok: true }
}

export function mockAddTopic(body: AddTopicRequest): AddTopicResponse | { postId: number } {
  return body.url.includes('dup') ? { postId: 40 } : { ok: true, topicId: 900 }
}

/** Applies a post action to the mock state; 'stale' when the view was outdated. */
export function mockPostAction(
  id: number,
  name: string,
  body: unknown,
): MockPost | 'stale' | 'not_found' {
  const m = mockPosts.get(id)
  if (!m) return 'not_found'
  const p = m.post
  const b = (body ?? {}) as Record<string, unknown>
  const draft = p.status === 'PENDING_REVIEW' && b.revision === p.revision
  const at = (v: unknown) => p.status === 'SCHEDULED' && String(v) === p.scheduled_at
  const bump = () => {
    p.revision += 1
    p.updated_at = new Date().toISOString()
  }
  switch (name) {
    case 'approve':
      if (!draft) return 'stale'
      p.status = 'SCHEDULED'
      p.scheduled_at = hours(12)
      break
    case 'reject':
      if (!draft) return 'stale'
      p.status = 'REJECTED'
      p.reject_reason = b.reason as MockPost['post']['reject_reason']
      break
    case 'regenerate':
      if (!draft) return 'stale'
      p.text = `${p.text.split('. ')[0]}. (다시 쓴 글)`
      bump()
      break
    case 'edit': {
      if (!draft) return 'stale'
      const idx = Number(b.idx)
      if (idx === 1) p.text = String(b.text)
      else {
        const target = m.parts.find((x) => x.idx === idx)
        if (!target) return 'stale'
        target.text = String(b.text)
      }
      bump()
      break
    }
    case 'deletePart': {
      if (!draft) return 'stale'
      const idx = Number(b.idx)
      if (!m.parts.some((x) => x.idx === idx)) return 'stale'
      m.parts = m.parts.filter((x) => x.idx !== idx).map((x, i) => ({ ...x, idx: i + 2 }))
      bump()
      break
    }
    case 'unschedule':
      if (!at(b.scheduledAt)) return 'stale'
      p.status = 'PENDING_REVIEW'
      p.scheduled_at = null
      bump()
      break
    case 'publishNow':
      if (!at(b.scheduledAt)) return 'stale'
      p.scheduled_at = new Date().toISOString()
      break
    case 'retryParts':
      if (p.status !== 'PUBLISHED' || !m.parts.some((x) => x.status === 'FAILED')) return 'stale'
      for (const x of m.parts) if (x.status === 'FAILED') x.status = 'PENDING'
      break
    case 'revive':
      if (p.status !== 'EXPIRED' || p.revive.revived_at || p.digest_post_id) return 'stale'
      p.status = 'PENDING_REVIEW'
      p.origin = 'revived'
      p.revive = { ...p.revive, revived_at: new Date().toISOString(), from_text: p.text }
      bump()
      break
    default:
      return 'not_found'
  }
  return structuredClone(m)
}

/** Test helper: back to the initial mock posts. */
export const resetMockPosts = () => {
  mockPosts = buildMockPosts()
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

export const sessionFixture: AuthSessionResponse = {
  authenticated: true,
  csrf: 'mock-csrf',
  expiresAt: days(30),
}

const opsJobs = (): OpsResponse['jobs'] => [
  {
    name: 'threads-daily',
    queue: 'daily-pipeline',
    cron: '0 7 * * *',
    last: {
      state: 'completed',
      created_at: hours(-20),
      started_at: hours(-20),
      completed_at: hours(-19.9),
      error: null,
    },
    busy: false,
  },
  {
    name: 'gift-collect',
    queue: 'gift-collect',
    cron: '0 9,15,21 * * *',
    last: {
      state: 'failed',
      created_at: hours(-3),
      started_at: hours(-3),
      completed_at: hours(-3),
      error: 'gift list page 1: 503 Service Unavailable',
    },
    busy: false,
  },
  {
    name: 'musinsa-collect',
    queue: 'musinsa-collect',
    cron: '0 10,16,22 * * *',
    last: {
      state: 'active',
      created_at: hours(-0.02),
      started_at: hours(-0.02),
      completed_at: null,
      error: null,
    },
    busy: true,
  },
  {
    name: 'campaign-maintenance',
    queue: 'campaign-maintenance',
    cron: '0 * * * *',
    last: null,
    busy: false,
  },
  {
    name: 'collect-insights',
    queue: 'collect-insights',
    cron: '0 5 * * *',
    last: {
      state: 'completed',
      created_at: hours(-8),
      started_at: hours(-8),
      completed_at: hours(-8),
      error: null,
    },
    busy: false,
  },
]

let mockOpsState = opsJobs()

export const resetMockOps = () => {
  mockOpsState = opsJobs()
}

export const mockOps = (): OpsResponse => ({
  jobs: mockOpsState,
  settings: {
    dailyPostCount: 3,
    publishSlots: ['09:00', '13:00', '19:00'],
    threadChainEnabled: true,
    threadsDryRun: false,
    campaignDailyMax: 5,
    campaignRankMode: 'rule',
    timeZone: 'Asia/Seoul',
  },
  profile: {
    about: '개발자이고 키보드·주변기기와 생활용품에 관심이 많아요.',
    interests: ['키보드', '주변기기', '주방용품'],
    preferKeywords: ['기계식', '무선'],
    excludeKeywords: ['성인', '다이어트'],
    excludeBrands: ['예시브랜드'],
    maxCompetition: 500,
    minPriceWon: 15000,
    review: {
      tone: '담백하고 솔직한 반말',
      minChars: 300,
      maxChars: 800,
      points: ['쓴 기간', '좋았던 점', '아쉬운 점'],
    },
    disclosure: '[체험단으로 제품을 제공받아 작성한 후기예요]',
  },
})

/** Queues a job like the server: a busy job answers `queued: false` and changes nothing. */
export function mockRunOps(name: string): OpsRunResponse | 'not_found' {
  const job = mockOpsState.find((j) => j.name === name)
  if (!job) return 'not_found'
  if (job.busy) return { ok: true, queued: false }
  job.busy = true
  job.last = {
    state: 'created',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
  }
  return { ok: true, queued: true }
}
