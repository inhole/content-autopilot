import { FilmIcon, UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import {
  PublicationBadge,
  VideoOriginBadge,
  VideoStatusBadge,
} from '@/components/status-badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx'
import { formatDuration, formatShortDateTime } from '@/lib/format.ts'
import { useVideos } from '@/lib/queries.ts'
import type { VideoRow } from '@/lib/types.ts'

/** Link to the video that opens as a sheet over the list. */
export function useVideoLink() {
  const location = useLocation()
  return (id: number) => ({ to: `/videos/${id}`, state: { background: location } })
}

const titleOf = (v: Pick<VideoRow, 'id' | 'title'>) => v.title || `영상 #${v.id}`

/** `Reels 예약 10/26 19:00` per publication; `-` without any. */
function Publications({ row }: { row: VideoRow }) {
  if (row.publications.length === 0) return <span className="text-muted-foreground">-</span>
  return (
    <span className="flex flex-col gap-1">
      {row.publications.map((p) => (
        <span key={p.id} className="inline-flex items-center gap-2 whitespace-nowrap">
          <PublicationBadge platform={p.platform} status={p.status} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatShortDateTime(p.published_at ?? p.scheduled_at)}
          </span>
        </span>
      ))}
    </span>
  )
}

export function VideosTable({ rows }: { rows: VideoRow[] }) {
  const navigate = useNavigate()
  const videoLink = useVideoLink()
  if (rows.length === 0) {
    return (
      <EmptyState title="영상이 아직 없어요." icon={FilmIcon}>
        <Button asChild size="sm">
          <Link to="/videos/new">영상 올리기</Link>
        </Button>
      </EmptyState>
    )
  }
  const openRow = (v: VideoRow, target: EventTarget) => {
    if (target instanceof Element && target.closest('a, button')) return
    const l = videoLink(v.id)
    navigate(l.to, { state: l.state })
  }
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>상태</TableHead>
              <TableHead>제목</TableHead>
              <TableHead>출처</TableHead>
              <TableHead className="text-right">길이</TableHead>
              <TableHead>발행</TableHead>
              <TableHead>만든 시각</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((v) => (
              <TableRow key={v.id} className="cursor-pointer" onClick={(e) => openRow(v, e.target)}>
                <TableCell>
                  <VideoStatusBadge status={v.status} />
                </TableCell>
                <TableCell className="max-w-xs">
                  <Link
                    {...videoLink(v.id)}
                    className="block truncate underline-offset-4 hover:underline"
                  >
                    {titleOf(v)}
                  </Link>
                </TableCell>
                <TableCell>
                  <VideoOriginBadge postId={v.post_id} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDuration(v.duration_ms)}
                </TableCell>
                <TableCell>
                  <Publications row={v} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatShortDateTime(v.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((v) => (
          <li key={v.id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <VideoStatusBadge status={v.status} />
              <VideoOriginBadge postId={v.post_id} />
              <span className="tabular-nums">{formatDuration(v.duration_ms)}</span>
            </div>
            <Link {...videoLink(v.id)} className="break-words underline-offset-4 hover:underline">
              {titleOf(v)}
            </Link>
            <Publications row={v} />
          </li>
        ))}
      </ul>
    </>
  )
}

function VideosSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border" role="status" aria-label="불러오는 중">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none border-b" />
      ))}
    </div>
  )
}

export function VideosPage() {
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const q = useVideos(filter)
  return (
    <>
      <PageHeader
        title="영상"
        description="Reels·Shorts 숏폼 · 진행 중이거나 최근 7일에 바뀐 영상 · 시각은 한국 시간"
      >
        <Button asChild size="sm">
          <Link to="/videos/new">
            <UploadIcon data-icon="inline-start" />
            영상 올리기
          </Link>
        </Button>
      </PageHeader>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={filter}
        onValueChange={(v) => v && setFilter(v as 'active' | 'all')}
        aria-label="영상 필터"
        className="w-fit"
      >
        <ToggleGroupItem value="active">진행 중</ToggleGroupItem>
        <ToggleGroupItem value="all">전체</ToggleGroupItem>
      </ToggleGroup>
      <QueryBoundary query={q} skeleton={<VideosSkeleton />}>
        {(data) => <VideosTable rows={data.rows} />}
      </QueryBoundary>
    </>
  )
}
