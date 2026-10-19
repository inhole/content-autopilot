import { QueryClient } from '@tanstack/react-query'
import { SearchXIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from '@/components/layout.tsx'
import { EmptyState } from '@/components/query-state.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { CampaignDetailPage, CampaignSheet } from '@/pages/campaign-detail.tsx'
import { CampaignsPage } from '@/pages/campaigns.tsx'
import { OverviewPage } from '@/pages/overview.tsx'
import { PostsPage } from '@/pages/posts.tsx'

// recharts is heavy: the insights page (and the charts) load only when opened.
const InsightsPage = lazy(() =>
  import('@/pages/insights.tsx').then((m) => ({ default: m.InsightsPage })),
)

export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } })

function InsightsFallback() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="불러오는 중">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  )
}

export function AppRoutes() {
  const location = useLocation()
  // A row click opens the campaign as a sheet over the list: the list stays rendered from the
  // `background` location while the sheet route matches the real one.
  const background = (location.state as { background?: typeof location } | null)?.background
  return (
    <>
      <Routes location={background ?? location}>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="campaigns/:id" element={<CampaignDetailPage />} />
          <Route path="posts" element={<PostsPage />} />
          <Route
            path="insights"
            element={
              <Suspense fallback={<InsightsFallback />}>
                <InsightsPage />
              </Suspense>
            }
          />
          <Route
            path="*"
            element={
              <EmptyState title="찾을 수 없어요." icon={SearchXIcon}>
                <Button asChild variant="outline" size="sm">
                  <Link to="/">현황으로</Link>
                </Button>
              </EmptyState>
            }
          />
        </Route>
      </Routes>
      {background && (
        <Routes>
          <Route path="campaigns/:id" element={<CampaignSheet />} />
        </Routes>
      )}
    </>
  )
}
