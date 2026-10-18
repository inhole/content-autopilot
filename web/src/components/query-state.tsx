import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : '알 수 없는 오류'
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <p className="font-medium text-destructive">데이터를 불러오지 못했어요</p>
      <p className="mt-1 text-muted-foreground">{message}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        다시 시도
      </Button>
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** Renders loading / error / data for a query; `children` only sees defined data. */
export function QueryBoundary<T>({
  query,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (query.isPending) return <>{skeleton ?? <ListSkeleton />}</>
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>{children(query.data)}</>
}
