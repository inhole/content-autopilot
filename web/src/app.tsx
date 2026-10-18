import { QueryClient } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/layout.tsx'
import { EmptyState, ListSkeleton } from '@/components/query-state.tsx'
import { CampaignDetailPage } from '@/pages/campaign-detail.tsx'
import { CampaignsPage } from '@/pages/campaigns.tsx'
import { OverviewPage } from '@/pages/overview.tsx'
import { PostsPage } from '@/pages/posts.tsx'

// recharts is heavy: the insights page (and the charts) load only when opened.
const InsightsPage = lazy(() =>
  import('@/pages/insights.tsx').then((m) => ({ default: m.InsightsPage })),
)

export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } })

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="posts" element={<PostsPage />} />
        <Route
          path="insights"
          element={
            <Suspense fallback={<ListSkeleton rows={3} />}>
              <InsightsPage />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <EmptyState>
              찾을 수 없어요.{' '}
              <Link to="/" className="text-primary underline">
                현황으로
              </Link>
            </EmptyState>
          }
        />
      </Route>
    </Routes>
  )
}
