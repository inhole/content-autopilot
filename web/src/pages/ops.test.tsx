import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '@/lib/api.ts'
import { humanizeCron } from '@/lib/ops.ts'
import { mockOps, resetMockOps } from '@/mocks/fixtures.ts'
import { OpsPage } from './ops.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

let fetchMock: ReturnType<typeof vi.fn>
let ops = mockOps()

function serve(runResponse: Response = json({ ok: true, queued: true }, 202)) {
  fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST' ? runResponse : json(ops),
  )
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  resetMockOps()
  ops = mockOps()
  setCsrfToken('csrf-token')
  serve()
})
afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OpsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const card = (name: string) => screen.getByTestId(`job-${name}`)

describe('humanizeCron', () => {
  it('humanizes simple crons', () => {
    expect(humanizeCron('0 9,15,21 * * *')).toBe('매일 9·15·21시')
    expect(humanizeCron('0 * * * *')).toBe('매시 정각')
    expect(humanizeCron('0 5 * * *')).toBe('매일 5시')
    expect(humanizeCron('30 7 * * *')).toBe('매일 7시 30분')
    expect(humanizeCron('15 * * * *')).toBe('매시 15분')
    expect(humanizeCron('*/5 * * * *')).toBe('5분마다')
  })
  it('keeps the raw cron when it is not simple', () => {
    expect(humanizeCron('0 9 * * 1')).toBe('0 9 * * 1')
    expect(humanizeCron('0 9-18 * * *')).toBe('0 9-18 * * *')
    expect(humanizeCron('0 25 * * *')).toBe('0 25 * * *')
    expect(humanizeCron('weird')).toBe('weird')
  })
  it('says on-demand for no schedule', () => {
    expect(humanizeCron(null)).toBe('수동 실행만')
  })
})

describe('OpsPage', () => {
  it('shows every job with schedule and last-run state', async () => {
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    expect(screen.getByText('카카오톡 선물하기 체험단 수집')).toBeInTheDocument()
    expect(screen.getByText('무신사 체험단 수집')).toBeInTheDocument()
    expect(screen.getByText('체험단 마감 정리·리마인더')).toBeInTheDocument()
    expect(screen.getByText('Threads 성과 수집')).toBeInTheDocument()

    expect(within(card('gift-collect')).getByText('매일 9·15·21시')).toBeInTheDocument()
    expect(within(card('campaign-maintenance')).getByText('매시 정각')).toBeInTheDocument()
    expect(within(card('collect-insights')).getByText('매일 5시')).toBeInTheDocument()

    expect(within(card('threads-daily')).getByText('완료')).toBeInTheDocument()
    expect(within(card('gift-collect')).getByText('실패')).toBeInTheDocument()
    expect(within(card('gift-collect')).getByText(/503 Service Unavailable/)).toBeInTheDocument()
    expect(within(card('campaign-maintenance')).getByText(/아직 실행 기록이 없어요/)).toBeInTheDocument()
    expect(within(card('musinsa-collect')).getByText('실행 중')).toBeInTheDocument()
    expect(within(card('musinsa-collect')).getByText('대기·실행 중')).toBeInTheDocument()
  })

  it('confirms, then posts the run with the job name', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    await user.click(within(card('threads-daily')).getByRole('button', { name: '지금 실행' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/LLM을 호출하고 새 초안을 만들어요/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: '실행하기' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(call).toBeTruthy()
      const [path, init] = call as [string, RequestInit]
      expect(path).toBe('/api/ops/threads-daily/run')
      expect(JSON.parse(String(init.body))).toEqual({})
      expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token')
    })
    expect(await screen.findByText(/실행을 요청했어요/)).toBeInTheDocument()
  })

  it('does not post when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    await user.click(within(card('gift-collect')).getByRole('button', { name: '지금 실행' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '취소' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('says so when the job is already queued or running', async () => {
    serve(json({ ok: true, queued: false }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    await user.click(within(card('gift-collect')).getByRole('button', { name: '지금 실행' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '실행하기' }))
    expect(await screen.findByText('이미 대기 중이거나 실행 중이에요.')).toBeInTheDocument()
  })

  it('shows the server error when the run fails', async () => {
    serve(json({ error: '알 수 없는 작업이에요' }, 404))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    await user.click(within(card('gift-collect')).getByRole('button', { name: '지금 실행' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '실행하기' }))
    expect(await screen.findByText('알 수 없는 작업이에요')).toBeInTheDocument()
  })

  it('disables the run button of a busy job only', async () => {
    renderPage()
    await screen.findByText('Threads 뉴스 수집')
    expect(within(card('musinsa-collect')).getByRole('button', { name: '지금 실행' })).toBeDisabled()
    expect(within(card('gift-collect')).getByRole('button', { name: '지금 실행' })).toBeEnabled()
  })

  it('shows settings and the profile', async () => {
    renderPage()
    await screen.findByText('설정')
    expect(screen.getByText('3개')).toBeInTheDocument()
    expect(screen.getByText('09:00 · 13:00 · 19:00')).toBeInTheDocument()
    expect(screen.getByText('출처별 5개')).toBeInTheDocument()
    expect(screen.getByText('규칙 점수 (rule)')).toBeInTheDocument()
    expect(screen.getByText('키보드')).toBeInTheDocument()
    expect(screen.getByText('예시브랜드')).toBeInTheDocument()
    expect(screen.getByText('500:1')).toBeInTheDocument()
    expect(screen.getByText('15,000원')).toBeInTheDocument()
    expect(screen.getByText('300~800자')).toBeInTheDocument()
    expect(screen.getByText(/체험단으로 제품을 제공받아/)).toBeInTheDocument()
    expect(screen.getByText(/config\/campaign-profile\.json/)).toBeInTheDocument()
  })

  it('handles a missing profile', async () => {
    ops = { ...mockOps(), profile: null }
    serve()
    renderPage()
    expect(await screen.findByText('프로필을 읽지 못했어요.')).toBeInTheDocument()
  })
})
