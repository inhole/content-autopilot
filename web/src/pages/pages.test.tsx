import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes, createQueryClient } from '@/app.tsx'
import {
  campaignDetailFixture,
  campaignRowsFixture,
  insightsFixture,
  overviewFixture,
  postsFixture,
} from '@/mocks/fixtures.ts'
import { CampaignDetailView } from './campaign-detail.tsx'
import { CampaignTable } from './campaigns.tsx'
import { InsightsView } from './insights.tsx'
import { OverviewView } from './overview.tsx'
import { PostsTable } from './posts.tsx'

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>

// ResizeObserver is missing in jsdom (recharts ResponsiveContainer).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => vi.unstubAllGlobals())

describe('OverviewView', () => {
  it('shows Threads cards, scheduled list and campaign counts', () => {
    render(wrap(<OverviewView data={overviewFixture} />))
    expect(screen.getByText('최근 24시간 발행')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '발행 예정' })).toBeInTheDocument()
    expect(screen.getByText(/Vite 7 나왔음/)).toBeInTheDocument()
    expect(screen.getByText(/그때 확인한 체험단 475건/)).toBeInTheDocument()
    expect(screen.getByText('선물하기 진행 중 (전체 317)')).toBeInTheDocument()
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
  it('shows an empty state', () => {
    render(wrap(<CampaignTable rows={[]} />))
    expect(screen.getByText('해당하는 체험단이 없어요.')).toBeInTheDocument()
  })
})

describe('CampaignDetailView', () => {
  it('renders fields, external link and a known thumbnail', () => {
    const data = campaignDetailFixture(103)
    if (!data) throw new Error('fixture')
    const { container } = render(wrap(<CampaignDetailView data={data} />))
    const link = screen.getByRole('link', { name: '선물하기에서 열기' })
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('st.kakaocdn.net'),
    )
    expect(screen.getByText(/review-d3/)).toBeInTheDocument()
    expect(screen.getByText(/둘째 날부터 효과를 느낌/)).toBeInTheDocument()
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
  it('shows origin labels and reactions', () => {
    render(wrap(<PostsTable rows={postsFixture.rows} />))
    expect(screen.getAllByText('♻️ 재활용').length).toBeGreaterThan(0)
    expect(screen.getAllByText('🗞 주간 묶음').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/조회 1,820 · 좋아요 31 · 답글 4/).length).toBeGreaterThan(0)
  })
  it('shows an empty state', () => {
    render(wrap(<PostsTable rows={[]} />))
    expect(screen.getByText('글이 아직 없어요.')).toBeInTheDocument()
  })
})

describe('InsightsView', () => {
  it('renders the top posts table and chart titles', () => {
    render(wrap(<InsightsView data={insightsFixture(7)} />))
    expect(screen.getByText(/일별 조회/)).toBeInTheDocument()
    expect(screen.getByText('조회수 상위 글')).toBeInTheDocument()
    expect(screen.getAllByText('1,820').length).toBeGreaterThan(0)
  })
  it('shows an empty state without data', () => {
    render(wrap(<InsightsView data={{ days: 7, daily: [], top: [] }} />))
    expect(screen.getByText(/반응이 아직 없어요/)).toBeInTheDocument()
    expect(screen.getByText('아직 집계된 글이 없어요.')).toBeInTheDocument()
  })
})

describe('routing with the API', () => {
  const renderApp = (path: string) =>
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it('loads the overview through fetch with same-origin credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(overviewFixture)))
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/')
    await waitFor(() => expect(screen.getByText(/그때 확인한 체험단 475건/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/overview',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('shows an error state with retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: '서버 오류' }), { status: 500 })),
    )
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { retry: false } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/posts']}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('서버 오류'))
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })

  it('passes status and source from the URL to the API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filter: {}, rows: [] })))
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/campaigns?status=APPLIED&source=musinsa')
    await waitFor(() => expect(screen.getByText('해당하는 체험단이 없어요.')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/campaigns?status=APPLIED&source=musinsa',
      expect.anything(),
    )
  })
})
