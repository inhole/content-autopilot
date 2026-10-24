import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '@/lib/api.ts'
import {
  isPostWatchPending,
  isPostWatchSlow,
  POST_SLOW_MS,
  type PostWatch,
  startPostWatch,
} from '@/lib/queries.ts'
import type { PostDetailResponse } from '@/lib/types.ts'
import { mockPostDetail, mockRevivable, resetMockPosts } from '@/mocks/fixtures.ts'
import { ExpiredPage } from './expired.tsx'
import { PostDetailView } from './post-detail.tsx'
import { AddTopicDialog } from './posts.tsx'

type Over = Partial<PostDetailResponse['post']>

function detail(id: number, over: Over = {}): PostDetailResponse {
  const d = mockPostDetail(id)
  if (!d) throw new Error('fixture')
  Object.assign(d.post, over)
  return d
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const OK = (d: PostDetailResponse | null = null, telegramSynced = true) =>
  json({ ok: true, telegramSynced, detail: d })

let fetchMock: ReturnType<typeof vi.fn>
let client: QueryClient

beforeEach(() => {
  resetMockPosts()
  setCsrfToken('csrf-token')
  fetchMock = vi.fn(async () => OK())
  vi.stubGlobal('fetch', fetchMock)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
)

function renderView(d: PostDetailResponse, watch: PostWatch | null = null, now?: Date) {
  return render(wrap(<PostDetailView data={d} watch={watch} now={now} />))
}

/** The last POST: path and parsed body. */
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
const none = (name: string | RegExp) => expect(screen.queryByRole('button', { name })).toBeNull()

describe('actions by status', () => {
  it('PENDING_REVIEW: 승인, 재생성, 폐기 and per-part edit; no schedule buttons', () => {
    renderView(detail(52))
    expect(button('승인')).toBeInTheDocument()
    expect(button('재생성')).toBeInTheDocument()
    expect(button('폐기')).toBeInTheDocument()
    expect(button('본 글 수정')).toBeInTheDocument()
    expect(button('답글 2 수정')).toBeInTheDocument()
    expect(button('답글 3 삭제')).toBeInTheDocument()
    none('본 글 삭제')
    none('예약 취소')
    none('살리기')
  })
  it('SCHEDULED: 예약 취소 and 지금 발행 only', () => {
    renderView(detail(41))
    expect(button('예약 취소')).toBeInTheDocument()
    expect(button('지금 발행')).toBeInTheDocument()
    none('승인')
    none('본 글 수정')
  })
  it('PUBLISHED with a FAILED part: 답글 다시 시도; without one: no panel', () => {
    const { unmount } = renderView(detail(39))
    expect(button('답글 다시 시도')).toBeInTheDocument()
    expect(screen.getByText(/Threads API 500/)).toBeInTheDocument()
    unmount()
    renderView(detail(40))
    expect(screen.queryByTestId('post-actions')).toBeNull()
  })
  it('EXPIRED news draft: 살리기; revived or digested ones have none', () => {
    const { unmount } = renderView(detail(61))
    expect(button('살리기')).toBeInTheDocument()
    unmount()
    const digested = renderView(detail(61, { digest_post_id: 77 }))
    expect(screen.queryByTestId('post-actions')).toBeNull()
    expect(screen.getByRole('link', { name: '#77' })).toHaveAttribute('href', '/posts/77')
    digested.unmount()
    renderView(detail(61, { revive: { ...detail(61).post.revive, revived_at: new Date().toISOString() } }))
    expect(screen.queryByTestId('post-actions')).toBeNull()
  })
})

describe('displaying the post', () => {
  it('shows each part with its count against the right limit and the CTA on the last one', () => {
    renderView(detail(52))
    expect(screen.getByText('[1/3] 본 글')).toBeInTheDocument()
    expect(screen.getByText(/\/500자/, { selector: '[data-testid=part-1] span' })).toBeInTheDocument()
    expect(screen.getByText(/\/430자/)).toBeInTheDocument()
    expect(screen.getByText(/문구가 붙어요: 더 보고 싶으면 팔로우/)).toBeInTheDocument()
  })
  it('shows caveats, revive info and the original text of a revived post', async () => {
    renderView(detail(40))
    expect(screen.getByText('상록')).toBeInTheDocument()
    expect(screen.getByText('버전 요약이라 시간이 지나도 유효함')).toBeInTheDocument()
    expect(screen.queryByText(/어제 TypeScript 5.9이 나왔음/)).toBeNull()
    await userEvent.click(button('살리기 전 원문 보기'))
    expect(screen.getByText(/어제 TypeScript 5.9이 나왔음/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /원문 열기/ })).toBeInTheDocument()
  })
  it('lists the 확인 필요 caveats', () => {
    renderView(detail(51))
    expect(screen.getByText('가격은 아직 베타라 바뀔 수 있음')).toBeInTheDocument()
  })
})

describe('sending the displayed state', () => {
  it('approve sends the displayed revision after a confirmation', async () => {
    renderView(detail(51, { revision: 7 }))
    await userEvent.click(button('승인'))
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false)
    await userEvent.click(await screen.findByRole('button', { name: '승인하기' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const p = lastPost()
    expect(p.path).toBe('/api/posts/51/approve')
    expect(p.body).toEqual({ revision: 7 })
    expect(p.headers['x-csrf-token']).toBe('csrf-token')
    expect(await screen.findByText(/승인했어요/)).toBeInTheDocument()
  })
  it('reject needs a reason and sends its code', async () => {
    renderView(detail(51, { revision: 2 }))
    await userEvent.click(button('폐기'))
    const confirm = await screen.findByRole('button', { name: '폐기하기' })
    expect(confirm).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: '중복' }))
    await userEvent.click(confirm)
    await waitFor(() => expect(lastPost().body).toEqual({ revision: 2, reason: 'dup' }))
    expect(lastPost().path).toBe('/api/posts/51/reject')
  })
  it('regenerate sends optional feedback and starts watching', async () => {
    const onWatch = vi.fn()
    render(wrap(<PostDetailView data={detail(51, { revision: 3 })} onWatch={onWatch} />))
    await userEvent.click(button('재생성'))
    await userEvent.type(await screen.findByLabelText('고칠 점 (선택)'), '더 짧게')
    await userEvent.click(screen.getByRole('button', { name: '다시 쓰기' }))
    await waitFor(() => expect(onWatch).toHaveBeenCalled())
    expect(lastPost().path).toBe('/api/posts/51/regenerate')
    expect(lastPost().body).toEqual({ revision: 3, feedback: '더 짧게' })
    expect(onWatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'regenerate', revision: 3 })
  })
  it('deleting a follow-up sends its idx', async () => {
    renderView(detail(52, { revision: 4 }))
    await userEvent.click(button('답글 3 삭제'))
    await userEvent.click(await screen.findByRole('button', { name: '삭제하기' }))
    await waitFor(() => expect(lastPost().body).toEqual({ revision: 4, idx: 3 }))
    expect(lastPost().path).toBe('/api/posts/52/deletePart')
  })
  it('schedule actions send the displayed scheduled_at', async () => {
    const d = detail(41)
    const at = d.post.scheduled_at as string
    renderView(d)
    await userEvent.click(button('예약 취소'))
    await waitFor(() => expect(lastPost().body).toEqual({ scheduledAt: at }))
    expect(lastPost().path).toBe('/api/posts/41/unschedule')
    await userEvent.click(button('지금 발행'))
    expect(screen.getByText(/5분 안에 올라가요/)).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '지금 발행' }))
    await waitFor(() => expect(lastPost().path).toBe('/api/posts/41/publishNow'))
    expect(lastPost().body).toEqual({ scheduledAt: at })
  })
  it('retryParts and revive send empty bodies', async () => {
    const a = renderView(detail(39))
    await userEvent.click(button('답글 다시 시도'))
    await waitFor(() => expect(lastPost().path).toBe('/api/posts/39/retryParts'))
    expect(lastPost().body).toEqual({})
    a.unmount()
    renderView(detail(61))
    await userEvent.click(button('살리기'))
    await waitFor(() => expect(lastPost().path).toBe('/api/posts/61/revive'))
  })
})

describe('part editor', () => {
  it('counts live and disables saving over the limit', async () => {
    renderView(detail(51, { revision: 5 }))
    await userEvent.click(button('본 글 수정'))
    const box = screen.getByLabelText('본 글 수정')
    const save = button('저장')
    fireEvent.change(box, { target: { value: 'a'.repeat(500) } })
    expect(screen.getByText('500/500자')).toBeInTheDocument()
    expect(save).toBeEnabled()
    fireEvent.change(box, { target: { value: 'a'.repeat(501) } })
    expect(screen.getByText(/501\/500자/)).toBeInTheDocument()
    expect(screen.getByText(/1자 넘었어요/)).toBeInTheDocument()
    expect(save).toBeDisabled()
    fireEvent.change(box, { target: { value: '고친 글' } })
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() =>
      expect(lastPost().body).toEqual({ revision: 5, idx: 1, text: '고친 글' }),
    )
    expect(lastPost().path).toBe('/api/posts/51/edit')
  })
  it('uses the shorter last-follow-up limit for the last part only', async () => {
    renderView(detail(52))
    await userEvent.click(button('답글 3 수정'))
    fireEvent.change(screen.getByLabelText('답글 3 수정'), { target: { value: 'b'.repeat(431) } })
    expect(screen.getByText(/431\/430자/)).toBeInTheDocument()
    expect(button('저장')).toBeDisabled()
    await userEvent.click(button('닫기'))
    await userEvent.click(button('답글 2 수정'))
    fireEvent.change(screen.getByLabelText('답글 2 수정'), { target: { value: 'b'.repeat(431) } })
    expect(button('저장')).toBeEnabled()
  })
})

describe('conflicts and notices', () => {
  it('409 shows the server message', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: '이미 처리됐거나 내용이 바뀌었어요', stale: true }, 409),
    )
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderView(detail(51))
    await userEvent.click(button('승인'))
    await userEvent.click(await screen.findByRole('button', { name: '승인하기' }))
    expect(await screen.findByText('이미 처리됐거나 내용이 바뀌었어요')).toBeInTheDocument()
    // the post, lists and overview are invalidated so the page catches up
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['post', 51] }),
    )
    for (const key of ['posts', 'revivable', 'overview'])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] })
  })
  it('telegramSynced false adds a note', async () => {
    fetchMock.mockImplementation(async () => OK(null, false))
    renderView(detail(39))
    await userEvent.click(button('답글 다시 시도'))
    expect(await screen.findByText(/텔레그램 메시지는 갱신하지 못했어요/)).toBeInTheDocument()
  })
})

describe('pending regeneration', () => {
  it('watch is pending until the revision or status changes', () => {
    const d = detail(51, { revision: 3 })
    const w = startPostWatch('regenerate', d.post, 1000)
    expect(isPostWatchPending(w, d.post)).toBe(true)
    expect(isPostWatchPending(w, { ...d.post, revision: 4 })).toBe(false)
    expect(isPostWatchPending(w, { ...d.post, status: 'REJECTED' })).toBe(false)
    expect(isPostWatchPending(null, d.post)).toBe(false)
    expect(isPostWatchSlow(w, 1000 + POST_SLOW_MS)).toBe(false)
    expect(isPostWatchSlow(w, 1001 + POST_SLOW_MS)).toBe(true)
  })
  it('shows 재생성 중… and disables the buttons while pending', () => {
    const d = detail(51, { revision: 3 })
    renderView(d, startPostWatch('regenerate', d.post))
    expect(screen.getByText(/재생성 중…/)).toBeInTheDocument()
    expect(button('승인')).toBeDisabled()
    expect(button('재생성')).toBeDisabled()
    expect(button('본 글 수정')).toBeDisabled()
  })
  it('says it is taking long after 10 minutes and re-enables the buttons', () => {
    const d = detail(51, { revision: 3 })
    const w = startPostWatch('regenerate', d.post, Date.now() - POST_SLOW_MS - 1000)
    renderView(d, w)
    expect(screen.getByText(/오래 걸려요/)).toBeInTheDocument()
    expect(button('재생성')).toBeEnabled()
  })
  it('shows nothing once the revision moved on', () => {
    const d = detail(51, { revision: 3 })
    const w = startPostWatch('regenerate', { ...d.post, revision: 2 })
    renderView(d, w)
    expect(screen.queryByText(/재생성 중…/)).toBeNull()
    expect(button('승인')).toBeEnabled()
  })
  it('revive shows 살리는 중…', () => {
    const d = detail(61)
    renderView(d, startPostWatch('revive', d.post))
    expect(screen.getByText(/살리는 중…/)).toBeInTheDocument()
    expect(button('살리기')).toBeDisabled()
  })
})

describe('AddTopicDialog', () => {
  it('sends the url and note, then says the draft is being written', async () => {
    render(wrap(<AddTopicDialog />))
    await userEvent.click(button('URL로 초안 만들기'))
    const submit = await screen.findByRole('button', { name: '초안 만들기' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('기사 URL'), 'https://example.com/a')
    await userEvent.type(screen.getByLabelText('한 줄 의견 (선택)'), '쓸 만함')
    await userEvent.click(submit)
    await waitFor(() => expect(lastPost().path).toBe('/api/posts/add'))
    expect(lastPost().body).toEqual({ url: 'https://example.com/a', note: '쓸 만함' })
    expect(await screen.findByText(/초안을 쓰고 있어요/)).toBeInTheDocument()
  })
  it('409 says it was already covered and links to that post', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'covered', postId: 40 }, 409))
    render(wrap(<AddTopicDialog />))
    await userEvent.click(button('URL로 초안 만들기'))
    await userEvent.type(await screen.findByLabelText('기사 URL'), 'https://example.com/dup')
    await userEvent.click(screen.getByRole('button', { name: '초안 만들기' }))
    expect(await screen.findByText(/이미 다룬 기사예요/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /글 #40 보기/ })).toHaveAttribute('href', '/posts/40')
  })
})

describe('ExpiredPage', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ ok: true, telegramSynced: true, detail: null })
      if (path === '/api/revivable') return json(mockRevivable())
      return json({ error: 'nf' }, 404)
    })
  })
  it('lists drafts with verdict badges and reasons', async () => {
    render(wrap(<ExpiredPage />))
    expect(await screen.findByText(/#61/)).toBeInTheDocument()
    expect(screen.getByText('상록')).toBeInTheDocument()
    expect(screen.getByText('시의성 지남')).toBeInTheDocument()
    expect(screen.getByText('미판정')).toBeInTheDocument()
    expect(screen.getByText(/시간이 지나도 변하지 않는 개념 설명/)).toBeInTheDocument()
  })
  it('판정 요청 posts to /api/revivable/check and explains where the result goes', async () => {
    render(wrap(<ExpiredPage />))
    await screen.findByText(/#61/)
    await userEvent.click(button('판정 요청'))
    await waitFor(() => expect(lastPost().path).toBe('/api/revivable/check'))
    expect(await screen.findByText(/결과는 텔레그램으로 오고/)).toBeInTheDocument()
  })
  it('주간 묶음 needs a confirmation, then posts to /api/digest', async () => {
    render(wrap(<ExpiredPage />))
    await screen.findByText(/#61/)
    await userEvent.click(button('주간 묶음 지금 만들기'))
    expect(screen.getByText(/최대 3개까지/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(lastPost().path).toBe('/api/digest'))
  })
  it('살리기 on a row revives that post', async () => {
    render(wrap(<ExpiredPage />))
    await screen.findByText(/#61/)
    await userEvent.click(button(/HTTP 캐시 살리기/))
    await waitFor(() => expect(lastPost().path).toBe('/api/posts/61/revive'))
    expect(await screen.findByText(/살리는 중이에요/)).toBeInTheDocument()
  })
  it('shows an empty state', async () => {
    fetchMock.mockImplementation(async () => json({ rows: [] }))
    render(wrap(<ExpiredPage />))
    expect(await screen.findByText('살릴 수 있는 만료 초안이 없어요.')).toBeInTheDocument()
  })
})
