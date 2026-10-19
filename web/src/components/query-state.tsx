import type { UseQueryResult } from '@tanstack/react-query'
import { InboxIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : '알 수 없는 오류'
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>데이터를 불러오지 못했어요</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
          다시 시도
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  title,
  description,
  icon: Icon = InboxIcon,
  children,
}: {
  title: string
  description?: string
  icon?: typeof InboxIcon
  children?: ReactNode
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
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

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}
