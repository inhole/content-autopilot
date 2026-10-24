import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { ErrorState } from '@/components/query-state.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { useSession } from '@/lib/queries.ts'

/** Renders the console only with a live session; otherwise sends the visitor to /login. */
export function RequireAuth() {
  const session = useSession()
  const location = useLocation()
  if (session.isPending) {
    return (
      <div className="flex min-h-svh flex-col gap-4 p-6" role="status" aria-label="불러오는 중">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (session.isError) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    )
  }
  if (!session.data.authenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return <Outlet />
}
