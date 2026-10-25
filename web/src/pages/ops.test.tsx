import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '@/lib/api.ts'
import { humanizeCron } from '@/lib/ops.ts'
import { mockOps, resetMockOps } from '@/mocks/fixtures.ts'
import type { OpsProfile } from '@/lib/types.ts'
import { OpsPage } from './ops.tsx'
import { buildProfile, toForm } from './ops-profile.tsx'

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

function renderPage(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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
    expect(screen.getByText('기본 파일')).toBeInTheDocument()
    expect(screen.getByText(/다시 배포하지 않아도/)).toBeInTheDocument()
  })

  it('handles a missing profile', async () => {
    ops = { ...mockOps(), profile: null }
    serve()
    renderPage()
    expect(await screen.findByText('프로필을 읽지 못했어요.')).toBeInTheDocument()
  })
})

describe('profile editing', () => {
  const dbProfile = (): OpsProfile => ({
    ...(mockOps().profile as OpsProfile),
    source: 'db',
    revision: 4,
  })
  type Reply = (path: string, body: Record<string, unknown>) => Response

  function serveProfile(reply: Reply) {
    fetchMock = vi.fn(async (path: string, init?: RequestInit) =>
      init?.method === 'POST' ? reply(path, JSON.parse(String(init.body))) : json(ops),
    )
    vi.stubGlobal('fetch', fetchMock)
  }
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  const lastBody = () => JSON.parse(String((posts().at(-1)?.[1] as RequestInit).body))
  const ok = (profile: OpsProfile) => json({ ok: true, profile })

  async function openEditor() {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('설정')
    await user.click(within(screen.getByTestId('profile-card')).getByRole('button', { name: '편집' }))
    return user
  }

  it('shows the source badge and hides reset for the file', async () => {
    renderPage()
    await screen.findByText('설정')
    expect(screen.getByText('기본 파일')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '기본 파일로 되돌리기' })).toBeNull()
  })

  it('shows the db badge and the reset button', async () => {
    ops = { ...mockOps(), profile: dbProfile() }
    serve()
    renderPage()
    expect(await screen.findByText('페이지에서 수정함')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '기본 파일로 되돌리기' })).toBeInTheDocument()
  })

  it('saves parsed lists and nulls with the displayed revision', async () => {
    ops = { ...mockOps(), profile: dbProfile() }
    serveProfile(() => ok(dbProfile()))
    const user = await openEditor()
    const interests = screen.getByLabelText(/^관심사/)
    expect(screen.getByText('관심사 (3개)')).toBeInTheDocument()
    await user.clear(interests)
    await user.type(interests, ' 마우스 {Enter}{Enter}마우스{Enter}모니터 ')
    expect(screen.getByText('관심사 (2개)')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('최대 경쟁률'))
    await user.clear(screen.getByLabelText('협찬 문구'))
    await user.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]?.[0]).toBe('/api/ops/profile')
    const body = lastBody()
    expect(body.revision).toBe(4)
    expect(body.profile.interests).toEqual(['마우스', '모니터'])
    expect(body.profile.maxCompetition).toBeNull()
    expect(body.profile.disclosure).toBeNull()
    expect(body.profile.minPriceWon).toBe(15000)
    expect(body.profile.review).toEqual({
      tone: '담백하고 솔직한 반말',
      minChars: 300,
      maxChars: 800,
      points: ['쓴 기간', '좋았던 점', '아쉬운 점'],
    })
    expect(await screen.findByText(/프로필을 저장했어요/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
  })

  it('saves on the revision the form was filled from, even after a refetch', async () => {
    ops = { ...mockOps(), profile: dbProfile() }
    serveProfile(() => json({ error: 'stale', stale: true }, 409))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    renderPage(client)
    await screen.findByText('설정')
    await user.click(within(screen.getByTestId('profile-card')).getByRole('button', { name: '편집' }))
    // Another tab saved meanwhile: polling brings revision 5 while this form shows revision 4.
    ops = { ...mockOps(), profile: { ...dbProfile(), revision: 5 } }
    const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length
    const before = gets()
    await client.invalidateQueries({ queryKey: ['ops'] })
    await waitFor(() => expect(gets()).toBeGreaterThan(before))
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(lastBody().revision).toBe(4)
  })

  it('resets on the revision shown when the confirmation opened', async () => {
    ops = { ...mockOps(), profile: dbProfile() }
    serveProfile(() => json({ error: 'stale', stale: true }, 409))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    renderPage(client)
    await user.click(await screen.findByRole('button', { name: '기본 파일로 되돌리기' }))
    const dialog = await screen.findByRole('alertdialog')
    ops = { ...mockOps(), profile: { ...dbProfile(), revision: 5 } }
    const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length
    const before = gets()
    await client.invalidateQueries({ queryKey: ['ops'] })
    await waitFor(() => expect(gets()).toBeGreaterThan(before))
    await user.click(within(dialog).getByRole('button', { name: '되돌리기' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(lastBody()).toEqual({ revision: 4 })
  })

  it('counts characters as code points, like the server', async () => {
    const emoji = '😀'.repeat(50)
    const base = toForm(dbProfile())
    expect(buildProfile({ ...base, interests: emoji }).ok).toBe(true)
    expect(buildProfile({ ...base, interests: `${emoji}a` }).ok).toBe(false)
  })

  it('blocks an invalid value on the client without posting', async () => {
    const user = await openEditor()
    const min = screen.getByLabelText('최소 글자 수')
    await user.clear(min)
    await user.type(min, '900')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText('최대 글자 수보다 작아야 해요')).toBeInTheDocument()
    expect(posts()).toHaveLength(0)
  })

  it('shows server field errors at the matching inputs', async () => {
    serveProfile(() =>
      json({ error: '허용 범위를 벗어났어요', fields: ['review.maxChars', 'interests.1'] }, 400),
    )
    const user = await openEditor()
    await user.click(screen.getByRole('button', { name: '저장' }))
    const max = await screen.findByLabelText('최대 글자 수')
    await waitFor(() => expect(max).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByLabelText(/^관심사/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('최소 글자 수')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText('허용 범위를 벗어났어요')).toHaveLength(2)
    // Still editing, so nothing is lost.
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
  })

  it('refetches and leaves the editor on a stale 409', async () => {
    serveProfile(() => json({ error: 'stale', stale: true }, 409))
    const user = await openEditor()
    const before = fetchMock.mock.calls.filter(([, init]) => !init?.method).length
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText(/다른 곳에서 먼저 바뀌었어요/)).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => !init?.method).length).toBeGreaterThan(before),
    )
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
  })

  it('discards edits on cancel', async () => {
    const user = await openEditor()
    const about = screen.getByLabelText(/^소개/)
    await user.clear(about)
    await user.type(about, '바뀐 소개')
    await user.click(screen.getByRole('button', { name: '취소' }))
    expect(posts()).toHaveLength(0)
    expect(screen.queryByText('바뀐 소개')).toBeNull()
    await user.click(within(screen.getByTestId('profile-card')).getByRole('button', { name: '편집' }))
    expect(screen.getByLabelText(/^소개/)).toHaveValue('개발자이고 키보드·주변기기와 생활용품에 관심이 많아요.')
  })

  it('resets after a confirmation with the displayed revision', async () => {
    ops = { ...mockOps(), profile: dbProfile() }
    serveProfile(() => ok({ ...dbProfile(), source: 'file', revision: 0 }))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '기본 파일로 되돌리기' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(posts()).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: '되돌리기' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]?.[0]).toBe('/api/ops/profile/reset')
    expect(lastBody()).toEqual({ revision: 4 })
    expect(await screen.findByText(/기본 파일 내용으로 되돌렸어요/)).toBeInTheDocument()
  })
})
