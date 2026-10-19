import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { Fragment, useSyncExternalStore } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { AppSidebar, NAV } from '@/components/app-sidebar.tsx'
import { ThemeToggle } from '@/components/theme-toggle.tsx'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { formatTime } from '@/lib/format.ts'

/** Section (and, for a campaign page, the campaign) the current path belongs to. */
export function crumbsFor(pathname: string): { label: string; to?: string }[] {
  const section = NAV.find((n) => n.match(pathname))
  const detail = pathname.match(/^\/campaigns\/(\d+)/)
  if (!section) return [{ label: '찾을 수 없음' }]
  if (detail) return [{ label: section.label, to: section.to }, { label: `#${detail[1]}` }]
  return [{ label: section.label }]
}

/** Latest successful fetch time across the cache, plus a spinner while refetching. */
function RefreshStatus() {
  const client = useQueryClient()
  const fetching = useIsFetching() > 0
  const cache = client.getQueryCache()
  const updated = useSyncExternalStore(
    (cb) => cache.subscribe(cb),
    () => Math.max(0, ...cache.getAll().map((q) => q.state.dataUpdatedAt)),
  )
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="off">
      {fetching && <Spinner aria-label="새로 고치는 중" className="size-3.5" />}
      {updated > 0 && (
        <span className="tabular-nums">
          <span className="hidden sm:inline">마지막 갱신 </span>
          {formatTime(new Date(updated))}
        </span>
      )}
    </div>
  )
}

function Header() {
  const { pathname } = useLocation()
  const crumbs = crumbsFor(pathname)
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
      <SidebarTrigger aria-label="사이드바 열기·닫기" className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem className="hidden sm:block">
            <BreadcrumbLink asChild>
              <Link to="/">Content Autopilot</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((c, i) => (
            <Fragment key={c.label}>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem>
                {i === crumbs.length - 1 || !c.to ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        <RefreshStatus />
        <ThemeToggle />
      </div>
    </header>
  )
}

export function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
