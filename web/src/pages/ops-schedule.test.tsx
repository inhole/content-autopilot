import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '@/lib/api.ts'
import type { OpsSchedule } from '@/lib/types.ts'
import { mockOps, mockSaveSchedule, resetMockOps } from '@/mocks/fixtures.ts'
import { OpsPage } from './ops.tsx'
import { buildSchedule, toScheduleForm } from './ops-schedule.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

let fetchMock: ReturnType<typeof vi.fn>
let ops = mockOps()

const dbSchedule = (): OpsSchedule => {
  const base = mockOps().schedule
  return {
    ...base,
    source: 'db',
    revision: 4,
    current: {
      ...base.current,
      threadsCollect: { cron: '30 6,18 * * *', daily: { minute: 30, hours: [6, 18] } },
      dailyPostCount: 5,
      publishSlots: ['08:00', '12:00'],
    },
  }
}

type Reply = (path: string, body: Record<string, unknown>) => Response
function serve(reply: Reply = () => json({ ok: true })) {
  fetchMock = vi.fn(async (path: string, init?: RequestInit) =>
    init?.method === 'POST' ? reply(path, JSON.parse(String(init.body))) : json(ops),
  )
  vi.stubGlobal('fetch', fetchMock)
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
const lastBody = () => JSON.parse(String((posts().at(-1)?.[1] as RequestInit).body))
const ok = (schedule: OpsSchedule, applied = true) => json({ ok: true, schedule, applied })

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

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OpsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const card = () => screen.getByTestId('schedule-card')

async function openEditor() {
  const user = userEvent.setup()
  renderPage()
  await screen.findByTestId('schedule-card')
  await user.click(within(card()).getByRole('button', { name: '편집' }))
  return user
}
const hour = (label: string, h: number) => screen.getByRole('button', { name: `${label} ${h}시` })
const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length

describe('schedule card', () => {
  it('shows the env badge and no reset for env values', async () => {
    renderPage()
    await screen.findByTestId('schedule-card')
    expect(within(card()).getByText('기본값(환경변수)')).toBeInTheDocument()
    expect(within(card()).getByText('매일 7시')).toBeInTheDocument()
    expect(within(card()).getByText('매일 9·15·21시')).toBeInTheDocument()
    expect(within(card()).getByText('09:00 · 13:00 · 19:00')).toBeInTheDocument()
    expect(within(card()).queryByText(/기본값:/)).toBeNull()
    expect(screen.queryByRole('button', { name: '기본값으로 되돌리기' })).toBeNull()
  })

  it('shows the db badge, reset and the default where a value differs', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve()
    renderPage()
    expect(await screen.findByText('페이지에서 수정함')).toBeInTheDocument()
    expect(within(card()).getByText('매일 6·18시 30분')).toBeInTheDocument()
    expect(within(card()).getByText('기본값: 매일 7시')).toBeInTheDocument()
    expect(within(card()).getByText('기본값: 3개')).toBeInTheDocument()
    expect(within(card()).getByText('기본값: 09:00 · 13:00 · 19:00')).toBeInTheDocument()
    // Unchanged values show no default.
    expect(within(card()).getAllByText(/기본값:/)).toHaveLength(3)
    expect(screen.getByRole('button', { name: '기본값으로 되돌리기' })).toBeInTheDocument()
  })
})

describe('schedule form', () => {
  it('starts from the current values and previews live', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve()
    const user = await openEditor()
    expect(screen.getByTestId('sched-summary-threadsCollect')).toHaveTextContent('매일 6·18시 30분')
    expect(hour('Threads 뉴스 수집', 6)).toHaveAttribute('aria-pressed', 'true')
    expect(hour('Threads 뉴스 수집', 7)).toHaveAttribute('aria-pressed', 'false')
    await user.click(hour('Threads 뉴스 수집', 7))
    expect(screen.getByTestId('sched-summary-threadsCollect')).toHaveTextContent(
      '매일 6·7·18시 30분',
    )
  })

  it('saves normalized hours, minute, slots and counts on the displayed revision', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve(() => ok(dbSchedule()))
    const user = await openEditor()
    await user.click(hour('카카오톡 선물하기 수집', 12))
    await user.click(hour('카카오톡 선물하기 수집', 9)) // off
    const min = screen.getByLabelText('카카오톡 선물하기 수집 분')
    await user.clear(min)
    await user.type(min, '5')
    const count = screen.getByLabelText('하루 초안 수')
    await user.clear(count)
    await user.type(count, '2')
    await user.click(screen.getByRole('button', { name: '시각 추가' }))
    // Out of order and a duplicate on purpose.
    fireEvent.change(screen.getByLabelText('발행 시각 3'), { target: { value: '08:00' } })
    fireEvent.change(screen.getByLabelText('발행 시각 1'), { target: { value: '20:30' } })
    await user.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]?.[0]).toBe('/api/ops/schedule')
    const body = lastBody()
    expect(body.revision).toBe(4)
    expect(body.schedule.giftCollect).toEqual({ minute: 5, hours: [12, 15, 21] })
    expect(body.schedule.threadsCollect).toEqual({ minute: 30, hours: [6, 18] })
    expect(body.schedule.dailyPostCount).toBe(2)
    expect(body.schedule.campaignDailyMax).toBe(5)
    expect(body.schedule.publishSlots).toEqual(['08:00', '12:00', '20:30'])
    expect(await screen.findByText('일정과 수량을 저장했어요.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
  })

  it('saves on the revision the form was filled from, even after a refetch', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve(() => json({ error: 'stale', stale: true }, 409))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    renderPage(client)
    await screen.findByTestId('schedule-card')
    await user.click(within(card()).getByRole('button', { name: '편집' }))
    ops = { ...mockOps(), schedule: { ...dbSchedule(), revision: 5 } }
    const before = gets()
    await client.invalidateQueries({ queryKey: ['ops'] })
    await waitFor(() => expect(gets()).toBeGreaterThan(before))
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(lastBody().revision).toBe(4)
  })

  it('blocks invalid values on the client without posting', async () => {
    const user = await openEditor()
    for (const h of [9, 15, 21]) await user.click(hour('카카오톡 선물하기 수집', h))
    const min = screen.getByLabelText('무신사 수집 분')
    await user.clear(min)
    await user.type(min, '60')
    const count = screen.getByLabelText('하루 초안 수')
    await user.clear(count)
    await user.type(count, '11')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText('시각을 하나 이상 골라 주세요')).toBeInTheDocument()
    expect(screen.getByLabelText('무신사 수집 분')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('하루 초안 수')).toHaveAttribute('aria-invalid', 'true')
    expect(posts()).toHaveLength(0)
  })

  it('blocks an empty slot, and removes and adds slots', async () => {
    const user = await openEditor()
    await user.click(screen.getByRole('button', { name: '발행 시각 3 삭제' }))
    expect(screen.queryByLabelText('발행 시각 3')).toBeNull()
    await user.click(screen.getByRole('button', { name: '시각 추가' }))
    fireEvent.change(screen.getByLabelText('발행 시각 3'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText(/시각을 넣어 주세요/)).toBeInTheDocument()
    expect(posts()).toHaveLength(0)
  })

  it('hints, without blocking, when slots are fewer than the daily count', async () => {
    const user = await openEditor()
    const count = screen.getByLabelText('하루 초안 수')
    await user.clear(count)
    await user.type(count, '5')
    expect(screen.getByTestId('slots-hint')).toHaveTextContent('3개')
    expect(screen.getByTestId('slots-hint')).toHaveTextContent('5개')
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
  })

  it('shows server field errors at the matching inputs', async () => {
    serve(() =>
      json(
        {
          error: '허용 범위를 벗어났어요',
          fields: ['giftCollect.hours', 'dailyPostCount', 'publishSlots.1'],
        },
        400,
      ),
    )
    const user = await openEditor()
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() =>
      expect(screen.getByLabelText('하루 초안 수')).toHaveAttribute('aria-invalid', 'true'),
    )
    expect(screen.getByLabelText('발행 시각 2')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('발행 시각 1')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText('허용 범위를 벗어났어요')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
  })

  it('refetches and leaves the editor on a stale 409', async () => {
    serve(() => json({ error: 'stale', stale: true }, 409))
    const user = await openEditor()
    const before = gets()
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText(/다른 곳에서 먼저 바뀌었어요/)).toBeInTheDocument()
    await waitFor(() => expect(gets()).toBeGreaterThan(before))
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
  })

  it('warns when saved but not applied', async () => {
    serve(() => ok(dbSchedule(), false))
    const user = await openEditor()
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText(/워커를 다시 시작하면 적용돼요/)).toBeInTheDocument()
  })

  it('discards edits on cancel', async () => {
    const user = await openEditor()
    await user.click(hour('Threads 뉴스 수집', 3))
    await user.click(screen.getByRole('button', { name: '취소' }))
    expect(posts()).toHaveLength(0)
    await user.click(within(card()).getByRole('button', { name: '편집' }))
    expect(hour('Threads 뉴스 수집', 3)).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows a save failure inside the sheet and keeps it open', async () => {
    serve(() => json({ error: 'internal error' }, 500))
    const user = await openEditor()
    const sheet = screen.getByRole('dialog', { name: '일정과 수량 편집' })
    await user.click(within(sheet).getByRole('button', { name: 'Threads 뉴스 수집 3시' }))
    await user.click(within(sheet).getByRole('button', { name: '저장' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('internal error')
    expect(hour('Threads 뉴스 수집', 3)).toHaveAttribute('aria-pressed', 'true')
  })

  it('edits in a side sheet; closing it discards the edits', async () => {
    const user = await openEditor()
    const sheet = screen.getByRole('dialog', { name: '일정과 수량 편집' })
    await user.click(within(sheet).getByRole('button', { name: 'Threads 뉴스 수집 3시' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posts()).toHaveLength(0)
    const edit = within(card()).getByRole('button', { name: '편집' })
    await waitFor(() => expect(edit).toHaveFocus())
    await user.click(edit)
    expect(hour('Threads 뉴스 수집', 3)).toHaveAttribute('aria-pressed', 'false')
  })

  it('starts a custom cron from the default and says it will be replaced', async () => {
    const s = mockOps().schedule
    ops = {
      ...mockOps(),
      schedule: {
        ...s,
        current: { ...s.current, giftCollect: { cron: '0 9-18 * * 1-5', daily: null } },
      },
    }
    serve()
    await openEditor()
    expect(hour('카카오톡 선물하기 수집', 15)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/0 9-18 \* \* 1-5.*바뀌어요/)).toBeInTheDocument()
  })

  it('starts empty when neither the current nor the default cron is simple', () => {
    const s = mockOps().schedule
    const custom = { cron: '*/10 * * * *', daily: null }
    const form = toScheduleForm({
      ...s,
      current: { ...s.current, giftCollect: custom },
      defaults: { ...s.defaults, giftCollect: custom },
    })
    expect(form.collects.giftCollect.hours).toEqual([])
    expect(buildSchedule(form).ok).toBe(false)
  })
})

describe('schedule reset', () => {
  it('resets on the revision shown when the confirmation opened', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve(() => json({ error: 'stale', stale: true }, 409))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    renderPage(client)
    await user.click(await screen.findByRole('button', { name: '기본값으로 되돌리기' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(posts()).toHaveLength(0)
    ops = { ...mockOps(), schedule: { ...dbSchedule(), revision: 5 } }
    const before = gets()
    await client.invalidateQueries({ queryKey: ['ops'] })
    await waitFor(() => expect(gets()).toBeGreaterThan(before))
    await user.click(within(dialog).getByRole('button', { name: '되돌리기' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]?.[0]).toBe('/api/ops/schedule/reset')
    expect(lastBody()).toEqual({ revision: 4 })
  })

  it('says so after a successful reset', async () => {
    ops = { ...mockOps(), schedule: dbSchedule() }
    serve(() => ok({ ...mockOps().schedule, revision: 5 }))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '기본값으로 되돌리기' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '되돌리기' }))
    expect(await screen.findByText(/기본값\(환경변수\)으로 되돌렸어요/)).toBeInTheDocument()
  })
})

describe('mock schedule handler', () => {
  it('accepts valid publish slots and normalizes them', () => {
    const res = mockSaveSchedule({
      revision: mockOps().schedule.revision,
      schedule: {
        threadsCollect: { minute: 0, hours: [6] },
        giftCollect: { minute: 0, hours: [21, 9, 15] },
        musinsaCollect: { minute: 30, hours: [10] },
        dailyPostCount: 3,
        publishSlots: ['21:00', '08:00', '12:30', '08:00'],
        campaignDailyMax: 3,
      },
    })
    expect(res).toMatchObject({ ok: true })
    if (res === 'stale' || !('schedule' in res) || !res.schedule) throw new Error('not saved')
    expect(res.schedule.current.publishSlots).toEqual(['08:00', '12:30', '21:00'])
    expect(res.schedule.current.giftCollect.daily?.hours).toEqual([9, 15, 21])
  })
})
