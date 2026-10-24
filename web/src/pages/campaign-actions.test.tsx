import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '@/lib/api.ts'
import { isDraftPending } from '@/lib/queries.ts'
import type { CampaignDetailResponse } from '@/lib/types.ts'
import { campaignDetailFixture } from '@/mocks/fixtures.ts'
import { CampaignActionsPanel } from './campaign-actions.tsx'
import { CampaignDetailView } from './campaign-detail.tsx'

type Over = Partial<CampaignDetailResponse['campaign']>

function detail(id: number, over: Over = {}): CampaignDetailResponse {
  const d = campaignDetailFixture(id)
  if (!d) throw new Error('fixture')
  Object.assign(d.campaign, over)
  return d
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const OK = (d: CampaignDetailResponse | null = null, telegramSynced = true) =>
  json({ ok: true, telegramSynced, detail: d })

let fetchMock: ReturnType<typeof vi.fn>
let client: QueryClient

beforeEach(() => {
  setCsrfToken('csrf-token')
  fetchMock = vi.fn(async () => OK())
  vi.stubGlobal('fetch', fetchMock)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function renderPanel(d: CampaignDetailResponse, now?: Date) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CampaignActionsPanel data={d} now={now} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The last POST: path, headers and parsed body. */
function lastPost() {
  const call = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1)
  if (!call) throw new Error('no POST sent')
  const [path, init] = call as [string, RequestInit]
  return {
    path,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  }
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })

describe('actions by status', () => {
  it('PENDING_REVIEW: 신청함 and 패스 only', () => {
    renderPanel(detail(101))
    expect(button('신청함')).toBeInTheDocument()
    expect(button('패스')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '선정' })).toBeNull()
    expect(screen.queryByLabelText('사용 메모')).toBeNull()
  })
  it('APPLIED: 선정 and 미선정', () => {
    renderPanel(detail(102))
    expect(button('선정')).toBeInTheDocument()
    expect(button('미선정')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '신청함' })).toBeNull()
  })
  it('SELECTED: deadline and memo, no draft controls', () => {
    renderPanel(detail(103))
    expect(screen.getByLabelText('리뷰 기한')).toBeInTheDocument()
    expect(screen.getByLabelText('사용 메모')).toBeInTheDocument()
    expect(button('초안 만들기')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '리뷰 올림' })).toBeNull()
  })
  it('DRAFT_REVIEW: regenerate, edit and 리뷰 올림', () => {
    renderPanel(detail(103, { status: 'DRAFT_REVIEW', revision: 4 }))
    expect(button('메모 저장하고 다시 쓰기')).toBeInTheDocument()
    expect(button('다시 쓰기')).toBeInTheDocument()
    expect(button('초안 직접 수정')).toBeInTheDocument()
    expect(button('리뷰 올림')).toBeInTheDocument()
  })
  it('shows nothing for finished campaigns', () => {
    renderPanel(detail(104))
    expect(screen.queryByTestId('campaign-actions')).toBeNull()
  })
})

describe('sending actions', () => {
  it('신청함 posts the revision with the CSRF header and shows the result', async () => {
    const user = userEvent.setup()
    renderPanel(detail(101, { revision: 3 }))
    await user.click(button('신청함'))
    await waitFor(() => expect(lastPost().path).toBe('/api/campaigns/101/apply'))
    const post = lastPost()
    expect(post.body).toEqual({ revision: 3 })
    expect(post.headers['x-csrf-token']).toBe('csrf-token')
    expect(await screen.findByText('신청으로 기록했어요')).toBeInTheDocument()
  })

  it('패스 asks for a reason in a confirmation dialog first', async () => {
    const user = userEvent.setup()
    renderPanel(detail(101, { revision: 3 }))
    await user.click(button('패스'))
    const dialog = await screen.findByRole('alertdialog')
    expect(fetchMock).not.toHaveBeenCalled()
    const confirm = within(dialog).getByRole('button', { name: '패스하기' })
    expect(confirm).toBeDisabled()
    await user.click(within(dialog).getByRole('radio', { name: '경쟁률이 너무 높음' }))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({
      path: '/api/campaigns/101/reject',
      body: { revision: 3, reason: 'competition' },
    })
  })

  it('cancelling the 패스 dialog sends nothing', async () => {
    const user = userEvent.setup()
    renderPanel(detail(101))
    await user.click(button('패스'))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '취소' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('선정 is direct, 미선정 needs confirmation', async () => {
    const user = userEvent.setup()
    renderPanel(detail(102))
    await user.click(button('선정'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastPost()).toMatchObject({ path: '/api/campaigns/102/result', body: { selected: true } })

    await user.click(button('미선정'))
    const dialog = await screen.findByRole('alertdialog')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await user.click(within(dialog).getByRole('button', { name: '미선정으로 기록' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(lastPost().body).toEqual({ selected: false })
  })

  it('리뷰 올림 needs confirmation', async () => {
    const user = userEvent.setup()
    renderPanel(detail(103, { status: 'DRAFT_REVIEW', revision: 4 }))
    await user.click(button('리뷰 올림'))
    const dialog = await screen.findByRole('alertdialog')
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '올렸어요' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({ path: '/api/campaigns/103/posted', body: { revision: 4 } })
  })

  it('sends the deadline text as typed', async () => {
    const user = userEvent.setup()
    renderPanel(detail(103))
    expect(button('기한 저장')).toBeDisabled()
    await user.type(screen.getByLabelText('리뷰 기한'), '10/30')
    await user.click(button('기한 저장'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({
      path: '/api/campaigns/103/deadline',
      body: { status: 'SELECTED', date: '10/30' },
    })
  })

  it('sends the memo with the status and revision shown', async () => {
    const user = userEvent.setup()
    renderPanel(detail(103, { memo: null, revision: 2 }))
    expect(button('초안 만들기')).toBeDisabled()
    await user.type(screen.getByLabelText('사용 메모'), '일주일 써봤음')
    await user.click(button('초안 만들기'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({
      path: '/api/campaigns/103/memo',
      body: { status: 'SELECTED', revision: 2, memo: '일주일 써봤음' },
    })
  })

  it('regenerates with optional feedback', async () => {
    const user = userEvent.setup()
    renderPanel(detail(103, { status: 'DRAFT_REVIEW', revision: 4 }))
    await user.type(screen.getByLabelText('다시 쓰기'), '더 짧게')
    await user.click(button('다시 쓰기'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({
      path: '/api/campaigns/103/regenerate',
      body: { revision: 4, feedback: '더 짧게' },
    })
  })

  it('edits the draft in place and saves it', async () => {
    const user = userEvent.setup()
    renderPanel(detail(103, { status: 'DRAFT_REVIEW', revision: 4, draft_text: '옛 초안' }))
    await user.click(button('초안 직접 수정'))
    const editor = screen.getByLabelText('초안 직접 수정')
    expect(editor).toHaveValue('옛 초안')
    await user.clear(editor)
    await user.type(editor, '내가 고친 글')
    await user.click(button('저장'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastPost()).toMatchObject({
      path: '/api/campaigns/103/draft',
      body: { revision: 4, text: '내가 고친 글' },
    })
  })

  it('says when the Telegram card could not be updated', async () => {
    fetchMock.mockResolvedValueOnce(OK(null, false))
    const user = userEvent.setup()
    renderPanel(detail(101))
    await user.click(button('신청함'))
    expect(await screen.findByText(/텔레그램 카드는 갱신하지 못했어요/)).toBeInTheDocument()
  })

  it('invalidates the campaign, list and overview queries after success', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    const user = userEvent.setup()
    renderPanel(detail(101))
    await user.click(button('신청함'))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy.mock.calls.map(([f]) => f?.queryKey)).toEqual([
      ['campaign', 101],
      ['campaigns'],
      ['overview'],
    ])
  })
})

describe('outdated view (409)', () => {
  it('shows the server message and refetches the campaign', async () => {
    const message = '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요'
    fetchMock.mockResolvedValueOnce(json({ error: message, stale: true }, 409))
    const spy = vi.spyOn(client, 'invalidateQueries')
    const user = userEvent.setup()
    renderPanel(detail(101))
    await user.click(button('신청함'))
    expect(await screen.findByText(message)).toBeInTheDocument()
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['campaign', 101] }))
  })
  it('shows other errors as they come', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: '날짜를 읽을 수 없어요' }, 400))
    const user = userEvent.setup()
    renderPanel(detail(103))
    await user.type(screen.getByLabelText('리뷰 기한'), 'abc')
    await user.click(button('기한 저장'))
    expect(await screen.findByText('날짜를 읽을 수 없어요')).toBeInTheDocument()
  })
})

describe('draft being written', () => {
  const pending = { status: 'SELECTED' as const, regen_seq: 2, draft_seq: 1, memo: '메모' }

  it('is pending only while regen_seq is ahead of draft_seq', () => {
    expect(isDraftPending(detail(103, pending).campaign)).toBe(true)
    expect(isDraftPending(detail(103, { regen_seq: 2, draft_seq: 2 }).campaign)).toBe(false)
    expect(isDraftPending(detail(104, { regen_seq: 5, draft_seq: 0 }).campaign)).toBe(false)
  })
  it('shows a working state and blocks new requests meanwhile', () => {
    renderPanel(detail(103, { ...pending, updated_at: new Date().toISOString() }), new Date())
    expect(screen.getByText(/초안 작성 중이에요/)).toBeInTheDocument()
    expect(button('초안 만들기')).toBeDisabled()
  })
  it('warns after a long wait and lets the owner try again', () => {
    const d = detail(103, { ...pending, updated_at: '2026-10-20T00:00:00.000Z' })
    renderPanel(d, new Date('2026-10-20T01:00:00Z'))
    expect(screen.getByText(/오래 걸려요/)).toBeInTheDocument()
    expect(button('초안 만들기')).toBeEnabled()
  })
  it('is not shown once the draft arrived', () => {
    renderPanel(detail(103, { ...pending, draft_seq: 2 }))
    expect(screen.queryByText(/초안 작성 중이에요/)).toBeNull()
  })
})

describe('copying the draft', () => {
  const view = (d: CampaignDetailResponse) =>
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CampaignDetailView data={d} />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it('copies the draft text to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    view(detail(103, { draft_text: '복사할 초안입니다' }))
    await user.click(button('초안 복사'))
    expect(writeText).toHaveBeenCalledWith('복사할 초안입니다')
    expect(await screen.findByText('복사했어요')).toBeInTheDocument()
  })
  it('tells the owner when copying is not possible', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    view(detail(103, { draft_text: '복사할 초안입니다' }))
    await user.click(button('초안 복사'))
    expect(await screen.findByText(/복사하지 못했어요/)).toBeInTheDocument()
  })
})
