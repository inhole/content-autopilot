import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import {
  formatDateTime,
  formatNumber,
  ORIGIN_LABELS,
  postStatusLabel,
  truncate,
} from '@/lib/format.ts'
import { usePosts } from '@/lib/queries.ts'
import type { PostItem } from '@/lib/types.ts'

function Reactions({ p }: { p: PostItem }) {
  if (p.views == null && p.likes == null && p.replies == null) return <>-</>
  return (
    <>
      조회 {formatNumber(p.views)} · 좋아요 {formatNumber(p.likes)} · 답글 {formatNumber(p.replies)}
    </>
  )
}

const StatusBadge = ({ p }: { p: PostItem }) => (
  <Badge variant={p.status === 'FAILED' ? 'destructive' : 'default'}>
    {postStatusLabel(p.status)}
  </Badge>
)

const Origin = ({ p }: { p: PostItem }) =>
  ORIGIN_LABELS[p.origin] ? <Badge variant="outline">{ORIGIN_LABELS[p.origin]}</Badge> : null

export function PostsTable({ rows }: { rows: PostItem[] }) {
  if (rows.length === 0) return <EmptyState>글이 아직 없어요.</EmptyState>
  return (
    <>
      <div className="hidden rounded-lg border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>상태</TableHead>
              <TableHead>예약</TableHead>
              <TableHead>발행</TableHead>
              <TableHead>내용</TableHead>
              <TableHead>반응</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <StatusBadge p={p} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDateTime(p.scheduled_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDateTime(p.published_at)}
                </TableCell>
                <TableCell className="max-w-md break-words">
                  <Origin p={p} /> {truncate(p.text, 80)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  <Reactions p={p} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((p) => (
          <li key={p.id} className="rounded-lg border bg-card p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge p={p} />
              <Origin p={p} />
              <span>예약 {formatDateTime(p.scheduled_at)}</span>
              <span>발행 {formatDateTime(p.published_at)}</span>
            </div>
            <p className="break-words">{truncate(p.text, 80)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              <Reactions p={p} />
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}

export function PostsPage() {
  const q = usePosts()
  return (
    <>
      <h1 className="text-lg font-semibold">최근 Threads 글</h1>
      <QueryBoundary query={q}>{(data) => <PostsTable rows={data.rows} />}</QueryBoundary>
    </>
  )
}
