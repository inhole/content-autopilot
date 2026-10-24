import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes, createQueryClient } from '@/app.tsx'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import {
  campaignDetailFixture,
  campaignRowsFixture,
  insightsFixture,
  overviewFixture,
  postsFixture,
  sessionFixture,
} from '@/mocks/fixtures.ts'
import type { CampaignRow } from '@/lib/types.ts'
import { CampaignDetailView } from './campaign-detail.tsx'
import { CampaignTable } from './campaigns.tsx'
import { InsightsView } from './insights.tsx'
import { OverviewView } from './overview.tsx'
import { PostsTable } from './posts.tsx'

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={createQueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
)

afterEach(() => vi.unstubAllGlobals())

describe('OverviewView', () => {
  it('shows Threads and campaign KPI cards, scheduled list and sources', () => {
    render(wrap(<OverviewView data={overviewFixture} />))
    expect(screen.getByText('최근 24시간 발행')).toBeInTheDocument()
    expect(screen.getByText('발행 예정', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
    expect(screen.getByText(/Vite 7 나왔음/)).toBeInTheDocument()
    expect(screen.getByText(/그때 확인한 체험단 475건/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '카카오톡 진행 중 8건, 전체 317건' })).toHaveAttribute(
      'href',
      '/campaigns?source=kakao-gift',
    )
    expect(screen.getByRole('link', { name: /^검수 대기 4/ })).toHaveAttribute(
      'href',
      '/campaigns?status=PENDING_REVIEW',
    )
  })
  it('shows empty states', () => {
    const empty = {
      posts: { pendingReview: 0, scheduled: [], published24h: 0, failed: 0 },
      campaigns: {
        counts: {},
        lastCollectedAt: null,
        lastSeenCount: 0,
        postedLast30d: 0,
        bySource: {},
      },
    }
    render(wrap(<OverviewView data={empty} />))
    expect(screen.getByText('발행 예정인 글이 없어요.')).toBeInTheDocument()
    expect(screen.getByText('아직 수집한 체험단이 없어요.')).toBeInTheDocument()
  })
})

describe('CampaignTable', () => {
  const now = new Date()
  it('renders competition, D-n and 추정 only for estimated deadlines', () => {
    render(wrap(<CampaignTable rows={campaignRowsFixture} now={now} />))
    expect(screen.getAllByText('23:1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('D-1').length).toBeGreaterThan(0)
    // row 101 is estimated, row 102 (musinsa) is not: exactly one 추정 per layout (table + cards).
    expect(screen.getAllByText('추정')).toHaveLength(2)
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: /#101/ })[0]).toHaveAttribute(
      'href',
      '/campaigns/101',
    )
  })
  it('shows the list price column, and a dash when the price is unknown', () => {
    render(wrap(<CampaignTable rows={campaignRowsFixture} now={now} />))
    expect(screen.getByRole('columnheader', { name: /정가/ })).toBeInTheDocument()
    expect(screen.getAllByText('49,000원').length).toBeGreaterThan(0)
    expect(screen.getAllByText('정가 49,000원').length).toBeGreaterThan(0)
  })
  it('emphasises deadlines of 2 days or less', () => {
    render(wrap(<CampaignTable rows={campaignRowsFixture} now={now} />))
    expect(screen.getAllByText('D-1')[0]).toHaveAttribute('data-variant', 'warning')
    expect(screen.getAllByText('D-5')[0]).toHaveAttribute('data-variant', 'outline')
  })
  it('searches title and brand even when the first row has no competition, score or deadline', async () => {
    const base = campaignRowsFixture[0] as CampaignRow
    const rows: CampaignRow[] = [
      { ...base, id: 1, title: '무선 이어폰', brand: '사운드랩', competition: null, score: null, next_deadline: null },
      { ...base, id: 2, title: '핸드크림 3종', brand: '비건하우스', competition: 3, score: 70 },
    ]
    render(wrap(<CampaignTable rows={rows} now={now} />))
    await userEvent.type(screen.getByPlaceholderText('제목·브랜드 검색'), '비건')
    await waitFor(() => expect(screen.queryAllByText(/무선 이어폰/)).toHaveLength(0))
    expect(screen.getAllByText(/핸드크림 3종/).length).toBeGreaterThan(0)
  })
  it('shows an empty state', () => {
    render(wrap(<CampaignTable rows={[]} />))
    expect(screen.getByText('해당하는 체험단이 없어요.')).toBeInTheDocument()
  })
  it('filters by title or brand and paginates', async () => {
    const many: CampaignRow[] = Array.from({ length: 45 }, (_, i) => {
      const base = campaignRowsFixture[0] as CampaignRow
      return { ...base, id: 1000 + i, title: `체험단 ${i}`, brand: i === 7 ? '특별브랜드' : 'x' }
    })
    const user = userEvent.setup()
    render(wrap(<CampaignTable rows={many} now={now} />))
    expect(screen.getByText(/45건 · 1 \/ 3 쪽/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /다음/ }))
    expect(screen.getByText(/45건 · 2 \/ 3 쪽/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '제목·브랜드 검색' }), '특별브랜드')
    expect(screen.getByText('1건')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /#1007/ }).length).toBeGreaterThan(0)
    await user.clear(screen.getByRole('textbox', { name: '제목·브랜드 검색' }))
    await user.type(screen.getByRole('textbox', { name: '제목·브랜드 검색' }), '없는검색어')
    expect(screen.getByText('검색 결과가 없어요.')).toBeInTheDocument()
  })
  it('sorts by score and puts missing values last', async () => {
    const user = userEvent.setup()
    render(wrap(<CampaignTable rows={campaignRowsFixture} now={now} />))
    const table = screen.getByRole('table')
    await user.click(within(table).getByRole('button', { name: '점수' }))
    const first = within(table).getAllByRole('row')[1] as HTMLElement
    expect(within(first).getByText('65')).toBeInTheDocument() // lowest score first
    const last = within(table).getAllByRole('row').at(-1) as HTMLElement
    expect(within(last).getByText(/#104/)).toBeInTheDocument() // null score stays last
    expect(within(table).getByRole('columnheader', { name: /점수/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })
})

describe('CampaignDetailView', () => {
  it('renders fields, external link and a known thumbnail', () => {
    const data = campaignDetailFixture(103)
    if (!data) throw new Error('fixture')
    const { container } = render(wrap(<CampaignDetailView data={data} />))
    const link = screen.getByRole('link', { name: '카카오톡에서 열기' })
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('st.kakaocdn.net'),
    )
    expect(screen.getByText(/review-d3/)).toBeInTheDocument()
    expect(screen.getByText(/둘째 날부터 효과를 느낌/, { selector: 'pre' })).toBeInTheDocument()
    for (const title of ['공고', '선별', '진행', '메모·초안'])
      expect(screen.getByText(title, { selector: '[data-slot=card-title]' })).toBeInTheDocument()
  })
  it('does not render images from unknown hosts and treats strings as text', () => {
    const data = campaignDetailFixture(101)
    if (!data) throw new Error('fixture')
    data.campaign.image_url = 'https://evil.example/x.jpg'
    data.campaign.title = '<img src=x onerror=alert(1)>'
    const { container } = render(wrap(<CampaignDetailView data={data} />))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument()
  })
  it('shows Musinsa facts and link label', () => {
    const data = campaignDetailFixture(102)
    if (!data) throw new Error('fixture')
    render(wrap(<CampaignDetailView data={data} />))
    expect(screen.getByRole('link', { name: '무신사에서 열기' })).toBeInTheDocument()
    expect(screen.getByText(/59,000원 → 41,300원/)).toBeInTheDocument()
    expect(screen.getByText('패션 소품')).toBeInTheDocument()
    expect(screen.getByText('2026-10-27')).toBeInTheDocument()
    expect(screen.getByText('2026-10-31 ~ 2026-11-14')).toBeInTheDocument()
  })
})

describe('PostsTable', () => {
  it('shows origin labels and reactions in numeric columns', () => {
    render(wrap(<PostsTable rows={postsFixture.rows} />))
    expect(screen.getAllByText('♻️ 재활용').length).toBeGreaterThan(0)
    expect(screen.getAllByText('🗞 주간 묶음').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1,820').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/조회 1,820 · 좋아요 31 · 답글 4/).length).toBeGreaterThan(0)
  })
  it('shows an empty state', () => {
    render(wrap(<PostsTable rows={[]} />))
    expect(screen.getByText('글이 아직 없어요.')).toBeInTheDocument()
  })
})

describe('InsightsView', () => {
  it('renders the charts, totals and the top posts table', () => {
    render(wrap(<InsightsView data={insightsFixture(7)} />))
    expect(screen.getByText('일별 조회')).toBeInTheDocument()
    expect(screen.getByText('일별 좋아요')).toBeInTheDocument()
    expect(screen.getByText('조회수 상위 글')).toBeInTheDocument()
    expect(screen.getAllByText('1,820').length).toBeGreaterThan(0)
  })
  it('switches the second chart between likes and replies', async () => {
    const user = userEvent.setup()
    render(wrap(<InsightsView data={insightsFixture(7)} />))
    await user.click(screen.getByRole('radio', { name: '답글' }))
    expect(screen.getByText('일별 답글')).toBeInTheDocument()
  })
  it('shows an empty state without data', () => {
    render(wrap(<InsightsView data={{ days: 7, daily: [], top: [] }} />))
    expect(screen.getByText(/반응이 아직 없어요/)).toBeInTheDocument()
    expect(screen.getByText('아직 집계된 글이 없어요.')).toBeInTheDocument()
  })
})

/** Stubs fetch with a live session; every other request goes to `handler`. */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) =>
      url === '/api/auth/session' ? new Response(JSON.stringify(sessionFixture)) : handler(url, init),
    ),
  )
}

function LocationProbe() {
  const l = useLocation()
  return <output data-testid="loc">{`${l.pathname}${l.search}`}</output>
}

describe('routing with the API', () => {
  const renderApp = (path: string, client = createQueryClient()) =>
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    )

  it('loads the overview through fetch with same-origin credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(overviewFixture)))
    stubFetch(fetchMock)
    renderApp('/')
    await waitFor(() => expect(screen.getByText(/그때 확인한 체험단 475건/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/overview',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    // The shell: sidebar sections and the last refresh time.
    for (const name of ['현황', '체험단', 'Threads 글', '성과'])
      expect(screen.getAllByRole('link', { name }).length).toBeGreaterThan(0)
    expect(screen.getByText(/마지막 갱신/)).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    stubFetch(
      vi.fn(async () => new Response(JSON.stringify({ error: '서버 오류' }), { status: 500 })),
    )
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { retry: false } })
    renderApp('/posts', client)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('서버 오류'))
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })

  it('passes status and source from the URL to the API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filter: {}, rows: [] })))
    stubFetch(fetchMock)
    renderApp('/campaigns?status=APPLIED&source=musinsa')
    await waitFor(() => expect(screen.getByText('해당하는 체험단이 없어요.')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/campaigns?status=APPLIED&source=musinsa',
      expect.anything(),
    )
  })

  it('writes the filters back to the URL', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ filter: {}, rows: campaignRowsFixture })),
    )
    stubFetch(fetchMock)
    const user = userEvent.setup()
    renderApp('/campaigns')
    await screen.findAllByRole('link', { name: /#101/ })
    await user.click(screen.getByRole('radio', { name: /무신사/ }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/campaigns?source=musinsa')
    await user.click(screen.getByRole('tab', { name: '신청함' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/campaigns?status=APPLIED&source=musinsa')
    await user.click(screen.getByRole('radio', { name: '모든 출처' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/campaigns?status=APPLIED')
  })

  it('opens a campaign as a sheet over the list and a full page on direct navigation', async () => {
    const detail = campaignDetailFixture(101)
    stubFetch(
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/campaigns/101')
          ? new Response(JSON.stringify(detail))
          : new Response(JSON.stringify({ filter: {}, rows: campaignRowsFixture })),
      ),
    )
    const user = userEvent.setup()
    const first = renderApp('/campaigns')
    await user.click((await screen.findAllByRole('link', { name: /#101/ }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('공고', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
    // The list stays rendered behind the sheet.
    expect(screen.getAllByRole('link', { name: /#102/, hidden: true }).length).toBeGreaterThan(0)
    first.unmount()

    renderApp('/campaigns/101')
    expect(await screen.findByRole('heading', { level: 1, name: /#101/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
