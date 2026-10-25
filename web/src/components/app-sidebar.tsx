import {
  ArchiveRestoreIcon,
  BarChart3Icon,
  FilmIcon,
  GiftIcon,
  LayoutDashboardIcon,
  MessageSquareTextIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { AccountMenu } from '@/components/account-menu.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar.tsx'
import { useOverview } from '@/lib/queries.ts'
import type { OverviewResponse } from '@/lib/types.ts'

type NavItem = {
  to: string
  label: string
  icon: typeof GiftIcon
  match: (p: string) => boolean
  /** Items waiting for the owner, shown as a badge next to the entry (tolerates a partial body). */
  waiting?: (o: OverviewResponse) => number
}

export const NAV: NavItem[] = [
  { to: '/', label: '현황', icon: LayoutDashboardIcon, match: (p: string) => p === '/' },
  {
    to: '/campaigns',
    label: '체험단',
    icon: GiftIcon,
    match: (p: string) => p.startsWith('/campaigns'),
    waiting: (o) => o.campaigns?.counts?.PENDING_REVIEW ?? 0,
  },
  {
    to: '/posts',
    label: 'Threads 글',
    icon: MessageSquareTextIcon,
    match: (p: string) => p.startsWith('/posts'),
    waiting: (o) => o.posts?.pendingReview ?? 0,
  },
  {
    to: '/videos',
    label: '영상',
    icon: FilmIcon,
    match: (p: string) => p.startsWith('/videos'),
  },
  {
    to: '/expired',
    label: '만료 초안',
    icon: ArchiveRestoreIcon,
    match: (p: string) => p.startsWith('/expired'),
  },
  {
    to: '/insights',
    label: '성과',
    icon: BarChart3Icon,
    match: (p: string) => p.startsWith('/insights'),
  },
  {
    to: '/ops',
    label: '운영',
    icon: SlidersHorizontalIcon,
    match: (p: string) => p.startsWith('/ops'),
  },
]

/** A manuscript-paper cell with one character written in it. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="size-8 shrink-0">
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path
        d="M11.5 6v20M20.5 6v20M6 11.5h20M6 20.5h20"
        className="stroke-primary-foreground/45"
        strokeWidth="1.25"
      />
      <rect x="12.5" y="12.5" width="7" height="7" rx="1" className="fill-primary-foreground" />
    </svg>
  )
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const overview = useOverview().data
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Content Autopilot">
              <Link to="/" onClick={() => isMobile && setOpenMobile(false)}>
                <BrandMark />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Content Autopilot</span>
                  <span className="truncate text-xs text-muted-foreground">운영 대시보드</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => {
                const active = n.match(pathname)
                const waiting = (overview && n.waiting?.(overview)) || 0
                return (
                  <SidebarMenuItem key={n.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={waiting ? `${n.label} (검수 대기 ${waiting})` : n.label}
                      className="data-[active=true]:text-sidebar-primary"
                    >
                      <Link
                        to={n.to}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => isMobile && setOpenMobile(false)}
                      >
                        <n.icon />
                        <span>{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {waiting > 0 && (
                      <SidebarMenuBadge
                        className="bg-warning/12 text-warning peer-hover/menu-button:text-warning peer-data-[active=true]/menu-button:text-warning"
                      >
                        <span className="sr-only">검수 대기 </span>
                        {waiting}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
