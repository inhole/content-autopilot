import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils.ts'

const NAV = [
  { to: '/', label: '현황', end: true },
  { to: '/campaigns', label: '체험단', end: false },
  { to: '/posts', label: 'Threads 글', end: false },
  { to: '/insights', label: '성과', end: false },
]

export function Layout() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-4 overflow-x-auto px-4 py-2">
          <strong className="shrink-0 text-sm">Content Autopilot</strong>
          <nav className="flex gap-1" aria-label="주 메뉴">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    'whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted',
                    isActive && 'bg-muted font-medium text-foreground',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-5">
        <Outlet />
      </main>
    </div>
  )
}
