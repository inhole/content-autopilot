import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes, createQueryClient } from '@/app.tsx'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { setCsrfToken } from '@/lib/api.ts'
import { overviewFixture, postsFixture } from '@/mocks/fixtures.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const LIVE = { authenticated: true, csrf: 'csrf-1', expiresAt: '2026-11-17T03:00:00.000Z' }

function LocationProbe() {
  const l = useLocation()
  return <output data-testid="loc">{l.pathname}</output>
}

function renderApp(path: string) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

type Call = { url: string; init?: RequestInit }

/** A fake server: `session` is the current session state, `routes` answer everything else. */
function fakeServer(routes: Record<string, (init?: RequestInit) => Response>, loggedIn = false) {
  const calls: Call[] = []
  let session: unknown = loggedIn ? LIVE : { authenticated: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/auth/session') return json(session)
      if (url === '/api/auth/login') {
        const r = routes[url]?.(init) ?? json(LIVE)
        if (r.ok) session = LIVE
        return r
      }
      const route = routes[url.split('?')[0] as string]
      return route ? route(init) : json({ error: 'not found' }, 404)
    }),
  )
  return calls
}

const header = (c: Call | undefined, name: string) =>
  (c?.init?.headers as Record<string, string> | undefined)?.[name]

describe('login', () => {
  it('sends a visitor without a session to the login page', async () => {
    fakeServer({})
    renderApp('/posts')
    expect(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' })).toBeInTheDocument()
    expect(screen.getByTestId('loc')).toHaveTextContent('/login')
  })

  it('requests a code, logs in with it and returns to the page it came from', async () => {
    const calls = fakeServer({
      '/api/auth/code': () => json({ expiresAt: '2026-10-18T03:05:00.000Z' }),
      '/api/posts': () => json(postsFixture),
    })
    const user = userEvent.setup()
    renderApp('/posts')
    await user.click(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' }))

    const codeCall = calls.find((c) => c.url === '/api/auth/code')
    expect(codeCall?.init?.method).toBe('POST')
    expect(header(codeCall, 'content-type')).toBe('application/json')
    expect(await screen.findByText('5분 동안 한 번만 쓸 수 있어요')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /초 뒤에 코드 다시 받기/ })).toBeDisabled()

    await user.keyboard('123456')
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/posts'))
    const loginCall = calls.find((c) => c.url === '/api/auth/login')
    expect(JSON.parse(String(loginCall?.init?.body))).toEqual({ code: '123456' })
    expect((await screen.findAllByText(/Claude Code/)).length).toBeGreaterThan(0)
  })

  it('shows the server error for a wrong code and clears the input', async () => {
    fakeServer({
      '/api/auth/code': () => json({ expiresAt: '2026-10-18T03:05:00.000Z' }),
      '/api/auth/login': () => json({ error: '코드가 맞지 않아요 (남은 시도 4번)' }, 401),
    })
    const user = userEvent.setup()
    renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' }))
    await screen.findByText('5분 동안 한 번만 쓸 수 있어요')
    await user.keyboard('000000')
    expect(await screen.findByRole('alert')).toHaveTextContent('남은 시도 4번')
    expect(screen.getByTestId('loc')).toHaveTextContent('/login')
    expect(screen.getByRole('button', { name: '로그인' })).toBeDisabled()
  })

  it('shows the rate limit and waits it out before another request', async () => {
    fakeServer({
      '/api/auth/code': () => json({ error: '42초 뒤에 다시 요청해 주세요', retryAfter: 42 }, 429),
    })
    const user = userEvent.setup()
    renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('42초 뒤에')
    expect(screen.getByRole('button', { name: /초 뒤에 다시 받을 수 있어요/ })).toBeDisabled()
  })

  it('goes straight to the console with a live session', async () => {
    fakeServer({ '/api/overview': () => json(overviewFixture) }, true)
    renderApp('/login')
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/))
  })
})

describe('session end', () => {
  it('returns to the login page when a data request answers 401', async () => {
    fakeServer({ '/api/posts': () => json({ error: '로그인이 필요해요' }, 401) }, true)
    renderApp('/posts')
    expect(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' })).toBeInTheDocument()
  })

  it('logs out with the CSRF token', async () => {
    const calls = fakeServer(
      {
        '/api/overview': () => json(overviewFixture),
        '/api/auth/logout': () => json({ ok: true }),
      },
      true,
    )
    const user = userEvent.setup()
    renderApp('/')
    await user.click(await screen.findByRole('button', { name: '로그아웃' }))
    expect(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' })).toBeInTheDocument()
    const logout = calls.find((c) => c.url === '/api/auth/logout')
    expect(header(logout, 'x-csrf-token')).toBe('csrf-1')
  })

  it('asks before ending every session', async () => {
    const calls = fakeServer(
      {
        '/api/overview': () => json(overviewFixture),
        '/api/auth/logout-all': () => json({ ok: true, revoked: 2 }),
      },
      true,
    )
    const user = userEvent.setup()
    renderApp('/')
    await user.click(await screen.findByRole('button', { name: '모든 세션 끊기' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('모든 세션을 끊을까요?')
    await user.click(screen.getByRole('button', { name: '취소' }))
    expect(calls.some((c) => c.url === '/api/auth/logout-all')).toBe(false)

    await user.click(screen.getByRole('button', { name: '모든 세션 끊기' }))
    await user.click(await screen.findByRole('button', { name: '모두 끊기' }))
    expect(await screen.findByRole('button', { name: 'Telegram으로 코드 받기' })).toBeInTheDocument()
    expect(header(calls.find((c) => c.url === '/api/auth/logout-all'), 'x-csrf-token')).toBe(
      'csrf-1',
    )
  })
})
