import { QueryCache, QueryClient } from '@tanstack/react-query'
import { SearchXIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from '@/components/layout.tsx'
import { EmptyState } from '@/components/query-state.tsx'
import { RequireAuth } from '@/components/require-auth.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { ApiError } from '@/lib/api.ts'
import { endSession, SESSION_KEY } from '@/lib/queries.ts'
import { CampaignDetailPage, CampaignSheet } from '@/pages/campaign-detail.tsx'
import { CampaignsPage } from '@/pages/campaigns.tsx'
import { ExpiredPage } from '@/pages/expired.tsx'
import { LoginPage } from '@/pages/login.tsx'
import { OpsPage } from '@/pages/ops.tsx'
import { OverviewPage } from '@/pages/overview.tsx'
import { PostDetailPage, PostSheet } from '@/pages/post-detail.tsx'
import { PostsPage } from '@/pages/posts.tsx'
import { VideoDetailPage, VideoSheet } from '@/pages/video-detail.tsx'
import { VideoUploadPage } from '@/pages/video-upload.tsx'
import { VideosPage } from '@/pages/videos.tsx'

// recharts is heavy: the insights page (and the charts) load only when opened.
const InsightsPage = lazy(() =>
  import('@/pages/insights.tsx').then((m) => ({ default: m.InsightsPage })),
)

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    // A 401 from any data request means the session ended (expired, revoked elsewhere):
    // RequireAuth then sends the visitor to the login page.
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          query.queryKey[0] !== SESSION_KEY[0]
        )
          endSession(client)
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
        refetchOnWindowFocus: true,
      },
    },
  })
  return client
}

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
        <Route path="login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route index element={<OverviewPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
            <Route path="campaigns/:id" element={<CampaignDetailPage />} />
            <Route path="posts" element={<PostsPage />} />
            <Route path="posts/:id" element={<PostDetailPage />} />
            <Route path="videos" element={<VideosPage />} />
            <Route path="videos/new" element={<VideoUploadPage />} />
            <Route path="videos/:id" element={<VideoDetailPage />} />
            <Route path="expired" element={<ExpiredPage />} />
            <Route path="ops" element={<OpsPage />} />
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
        </Route>
      </Routes>
      {background && (
        <Routes>
          <Route path="campaigns/:id" element={<CampaignSheet />} />
          <Route path="posts/:id" element={<PostSheet />} />
          <Route path="videos/:id" element={<VideoSheet />} />
        </Routes>
      )}
    </>
  )
}
