import {
  ActivityIcon,
  ArchiveRestoreIcon,
  BarChart3Icon,
  GiftIcon,
  LayoutDashboardIcon,
  MessageSquareTextIcon,
} from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { AccountMenu } from '@/components/account-menu.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar.tsx'

export const NAV = [
  { to: '/', label: '현황', icon: LayoutDashboardIcon, match: (p: string) => p === '/' },
  {
    to: '/campaigns',
    label: '체험단',
    icon: GiftIcon,
    match: (p: string) => p.startsWith('/campaigns'),
  },
  {
    to: '/posts',
    label: 'Threads 글',
    icon: MessageSquareTextIcon,
    match: (p: string) => p.startsWith('/posts'),
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
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Content Autopilot">
              <Link to="/" onClick={() => isMobile && setOpenMobile(false)}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <ActivityIcon />
                </div>
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
          <SidebarGroupLabel>메뉴</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => {
                const active = n.match(pathname)
                return (
                  <SidebarMenuItem key={n.to}>
                    <SidebarMenuButton asChild isActive={active} tooltip={n.label}>
                      <Link
                        to={n.to}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => isMobile && setOpenMobile(false)}
                      >
                        <n.icon />
                        <span>{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
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
