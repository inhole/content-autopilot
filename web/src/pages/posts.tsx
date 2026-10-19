import { MessageSquareTextIcon } from 'lucide-react'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { OriginBadge, PostStatusBadge } from '@/components/status-badge.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import { formatNumber, formatShortDateTime, truncate } from '@/lib/format.ts'
import { usePosts } from '@/lib/queries.ts'
import type { PostItem } from '@/lib/types.ts'

const num = 'text-right tabular-nums'

export function PostsTable({ rows }: { rows: PostItem[] }) {
  if (rows.length === 0) {
    return <EmptyState title="글이 아직 없어요." icon={MessageSquareTextIcon} />
  }
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>상태</TableHead>
              <TableHead>예약</TableHead>
              <TableHead>발행</TableHead>
              <TableHead>내용</TableHead>
              <TableHead className="text-right">조회</TableHead>
              <TableHead className="text-right">좋아요</TableHead>
              <TableHead className="text-right">답글</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <PostStatusBadge status={p.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatShortDateTime(p.scheduled_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatShortDateTime(p.published_at)}
                </TableCell>
                <TableCell className="max-w-sm">
                  <div className="flex items-center gap-2">
                    <OriginBadge origin={p.origin} />
                    <span className="min-w-0 truncate" title={p.text}>
                      {truncate(p.text, 80)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={num}>{formatNumber(p.views)}</TableCell>
                <TableCell className={num}>{formatNumber(p.likes)}</TableCell>
                <TableCell className={num}>{formatNumber(p.replies)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <PostStatusBadge status={p.status} />
              <OriginBadge origin={p.origin} />
              <span className="tabular-nums">예약 {formatShortDateTime(p.scheduled_at)}</span>
              <span className="tabular-nums">발행 {formatShortDateTime(p.published_at)}</span>
            </div>
            <p className="break-words">{truncate(p.text, 80)}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              조회 {formatNumber(p.views)} · 좋아요 {formatNumber(p.likes)} · 답글{' '}
              {formatNumber(p.replies)}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}

function PostsSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border" role="status" aria-label="불러오는 중">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none border-b" />
      ))}
    </div>
  )
}

export function PostsPage() {
  const q = usePosts()
  return (
    <>
      <PageHeader
        title="Threads 글"
        description="최근 글 50개 · 반응은 가장 최근에 수집한 값 · 시각은 한국 시간"
      />
      <QueryBoundary query={q} skeleton={<PostsSkeleton />}>
        {(data) => <PostsTable rows={data.rows} />}
      </QueryBoundary>
    </>
  )
}
