import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken, uploadContentType } from '@/lib/api.ts'
import type { VideoDetailResponse } from '@/lib/types.ts'
import { mockVideoDetail, mockVideoList, resetMockVideos } from '@/mocks/fixtures.ts'
import { parseHashtags, VideoDetailView } from './video-detail.tsx'
import { fileWarnings, VideoUploadPage } from './video-upload.tsx'
import { VideosTable } from './videos.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

let fetchMock: ReturnType<typeof vi.fn>
let client: QueryClient

beforeEach(() => {
  resetMockVideos()
  setCsrfToken('csrf-token')
  fetchMock = vi.fn(async () => json({ ok: true, telegramSynced: true, detail: null }))
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

function detail(id: number): VideoDetailResponse {
  const d = mockVideoDetail(id)
  if (!d) throw new Error('fixture')
  return d
}

/** The last POST: path and parsed body. */
function lastPost() {
  const call = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1)
  if (!call) throw new Error('no POST')
  return { path: String(call[0]), body: JSON.parse(String(call[1].body)) }
}

describe('helpers', () => {
  it('parses hashtags and picks the upload content type', () => {
    expect(parseHashtags('#AI, 개발  ##도구')).toEqual(['AI', '개발', '도구'])
    expect(uploadContentType({ type: '', name: 'clip.MOV' })).toBe('video/quicktime')
    expect(uploadContentType({ type: 'video/mp4', name: 'a.mp4' })).toBe('video/mp4')
  })

  it('warns early about size, orientation and length', () => {
    const big = new File(['x'], 'a.mp4')
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 })
    expect(fileWarnings(big, null)).toEqual(['50.0MB를 넘어서 올릴 수 없어요'])
    const small = new File(['x'], 'a.mp4')
    expect(fileWarnings(small, { durationMs: 200_000, width: 1920, height: 1080 })).toEqual([
      '가로 영상이에요. 세로 영상만 올릴 수 있어요',
      '3초~3분 영상만 올릴 수 있어요',
    ])
  })
})

describe('VideosTable', () => {
  it('lists videos with their origin and publications', () => {
    render(wrap(<VideosTable rows={mockVideoList('all').rows} />))
    const table = screen.getByRole('table')
    expect(within(table).getByText('Bun 1.2가 바꾼 것')).toBeInTheDocument()
    expect(within(table).getByText('글 #42')).toBeInTheDocument()
    expect(within(table).getAllByText('직접 올림').length).toBeGreaterThan(0)
    expect(within(table).getByText('Reels 예약')).toBeInTheDocument()
    expect(within(table).getByText('Shorts 실패')).toBeInTheDocument()
  })
})

describe('VideoDetailView', () => {
  it('approves an upload under review on its revision, without regeneration', async () => {
    const d = detail(3)
    fetchMock.mockResolvedValueOnce(json({ ok: true, telegramSynced: true, detail: d }))
    render(wrap(<VideoDetailView data={d} />))
    expect(screen.queryByRole('button', { name: '다시 만들기' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '승인' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '승인' }))
    await waitFor(() => expect(lastPost()).toEqual({ path: '/api/videos/3/approve', body: { revision: 1 } }))
    expect(await screen.findByText('승인했어요')).toBeInTheDocument()
  })

  it('saves title, caption and hashtags together', async () => {
    render(wrap(<VideoDetailView data={detail(3)} />))
    const tags = screen.getByLabelText('해시태그')
    await userEvent.clear(tags)
    await userEvent.type(tags, '#도구 AI')
    await userEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() =>
      expect(lastPost()).toEqual({
        path: '/api/videos/3/edit',
        body: {
          revision: 1,
          title: '직접 찍은 데모 영상',
          caption: '새 기능을 직접 써 봤어.',
          hashtags: ['도구', 'AI'],
        },
      }),
    )
  })

  it('needs the channel check before retrying an unknown Shorts outcome', async () => {
    render(wrap(<VideoDetailView data={detail(2)} />))
    // A publication was attempted: no unapprove.
    expect(screen.queryByRole('button', { name: '승인 취소' })).toBeNull()
    expect(screen.getByText(/발행을 시작한 뒤라/)).toBeInTheDocument()
    const shorts = screen.getByTestId('publication-22')
    const retry = within(shorts).getByRole('button', { name: '다시 시도' })
    expect(retry).toBeDisabled()
    await userEvent.click(within(shorts).getByRole('checkbox'))
    await userEvent.click(retry)
    await waitFor(() =>
      expect(lastPost()).toEqual({
        path: '/api/publications/22/retry',
        body: { claimSeq: 3, confirmedNotOnChannel: true },
      }),
    )
    // The scheduled one can go now, bound to its slot.
    const reels = screen.getByTestId('publication-21')
    await userEvent.click(within(reels).getByRole('button', { name: '지금 발행' }))
    await waitFor(() => expect(lastPost().body).toEqual({ scheduledAt: detail(2).publications[0]?.scheduled_at }))
  })

  it('shows the server message after a stale action', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요', stale: true }, 409),
    )
    render(wrap(<VideoDetailView data={detail(3)} />))
    await userEvent.click(screen.getByRole('button', { name: '폐기' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '폐기' }))
    expect(await screen.findByText('이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요')).toBeInTheDocument()
  })
})

/** XMLHttpRequest stand-in: answers each send with the next scripted response. */
class FakeXhr {
  static responses: { status: number; body: unknown }[] = []
  static sent: { url: string; headers: Record<string, string> }[] = []
  status = 0
  responseText = ''
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private url = ''
  private headers: Record<string, string> = {}
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send() {
    FakeXhr.sent.push({ url: this.url, headers: this.headers })
    const next = FakeXhr.responses.shift()
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
      if (!next) {
        this.onerror?.()
        return
      }
      this.status = next.status
      this.responseText = JSON.stringify(next.body)
      this.onload?.()
    }, 0)
  }
}

describe('VideoUploadPage', () => {
  beforeEach(() => {
    FakeXhr.responses = []
    FakeXhr.sent = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  const fill = async () => {
    render(wrap(<VideoUploadPage />))
    const file = new File(['video-bytes'], 'my clip.mp4', { type: 'video/mp4' })
    await userEvent.upload(screen.getByLabelText('영상 파일'), file)
    // The title starts from the file name.
    expect(screen.getByLabelText('제목')).toHaveValue('my clip')
    await userEvent.type(screen.getByLabelText('해시태그'), '#AI')
  }

  it('creates the row, sends the file with the CSRF token and reports the approval', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, id: 12, revision: 1 }))
    FakeXhr.responses.push({
      status: 200,
      body: { ok: true, approval: { ok: true, at: null, platforms: [] }, telegramSynced: true, detail: null },
    })
    await fill()
    await userEvent.click(screen.getByRole('button', { name: '올리기' }))
    expect(await screen.findByText(/올리고 승인했어요/)).toBeInTheDocument()
    expect(lastPost()).toEqual({
      path: '/api/videos',
      body: { title: 'my clip', caption: '', hashtags: ['AI'], sourceUrl: null, originalName: 'my clip.mp4' },
    })
    expect(FakeXhr.sent).toEqual([
      {
        url: '/api/videos/12/file?approve=1',
        headers: { accept: 'application/json', 'content-type': 'video/mp4', 'x-csrf-token': 'csrf-token' },
      },
    ])
  })

  it('keeps the row after a rejected file and sends the next file to the same row', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, id: 12, revision: 1 }))
    FakeXhr.responses.push({ status: 400, body: { error: '세로 영상만 올릴 수 있어요' } })
    FakeXhr.responses.push({
      status: 200,
      body: { ok: true, approval: null, telegramSynced: true, detail: null },
    })
    await fill()
    await userEvent.click(screen.getByLabelText(/바로 승인/))
    await userEvent.click(screen.getByRole('button', { name: '올리기' }))
    expect(await screen.findByText('세로 영상만 올릴 수 있어요')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '올리기' }))
    expect(await screen.findByText(/검수 대기로 들어갔고/)).toBeInTheDocument()
    // One row only: the second try went to /api/videos/12/file again.
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1)
    expect(FakeXhr.sent.map((s) => s.url)).toEqual([
      '/api/videos/12/file?approve=0',
      '/api/videos/12/file?approve=0',
    ])
  })

  it('reads the row after a dropped connection: a file that got in counts as done', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, id: 12, revision: 1 }))
      .mockResolvedValueOnce(json({ ...detail(3), video: { ...detail(3).video, id: 12, status: 'PENDING_REVIEW' } }))
    // No scripted response: the fake drops the connection.
    await fill()
    await userEvent.click(screen.getByRole('button', { name: '올리기' }))
    expect(await screen.findByText(/검수 대기로 들어갔고/)).toBeInTheDocument()
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('/api/videos/12')
  })
})
