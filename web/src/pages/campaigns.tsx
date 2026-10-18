import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { buttonVariants } from '@/components/ui/button.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import {
  daysUntil,
  formatCompetition,
  formatDday,
  SOURCES,
  sourceLabel,
  statusLabel,
} from '@/lib/format.ts'
import { useCampaigns } from '@/lib/queries.ts'
import type { CampaignRow } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

const STATUS_CHIPS = [
  'PENDING_REVIEW',
  'APPLIED',
  'SELECTED',
  'DRAFT_REVIEW',
  'POSTED',
  'NOT_SELECTED',
  'REJECTED',
  'EXPIRED',
  'SKIPPED',
  'SHORTLISTED',
  'COLLECTED',
]

const FILTER_CHIPS = [
  { value: 'active', label: '진행 중' },
  { value: 'all', label: '전체' },
  ...STATUS_CHIPS.map((s) => ({ value: s, label: statusLabel(s) })),
]

export const DEFAULT_STATUS = 'active'

const isSource = (v: string | null): v is (typeof SOURCES)[number]['key'] =>
  SOURCES.some((s) => s.key === v)

export function Chip({ to, on, children }: { to: string; on: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      replace
      aria-current={on}
      className={cn(buttonVariants({ variant: 'chip', size: 'chip' }), 'shrink-0')}
    >
      {children}
    </Link>
  )
}

/** `D-3`, plus `추정` only when the API marks the deadline as estimated. */
export function DeadlineBadge({ row, now }: { row: CampaignRow; now?: Date }) {
  const d = row.next_deadline
  if (!d) return <span className="text-muted-foreground">-</span>
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline">{formatDday(daysUntil(d.at, now))}</Badge>
      {d.estimated && <small className="text-muted-foreground">추정</small>}
    </span>
  )
}

const columns = (now?: Date): ColumnDef<CampaignRow>[] => [
  {
    id: 'title',
    header: '제목',
    cell: ({ row: { original: c } }) => (
      <Link to={`/campaigns/${c.id}`} className="font-medium text-primary hover:underline">
        #{c.id} {c.title || '(제목 없음)'}
      </Link>
    ),
  },
  { id: 'source', header: '출처', cell: ({ row }) => sourceLabel(row.original.source) },
  { id: 'brand', header: '브랜드', cell: ({ row }) => row.original.brand ?? '-' },
  {
    id: 'status',
    header: '상태',
    cell: ({ row }) => <Badge>{statusLabel(row.original.status)}</Badge>,
  },
  {
    id: 'competition',
    header: '경쟁률',
    cell: ({ row }) => formatCompetition(row.original.competition),
  },
  {
    id: 'deadline',
    header: '마감',
    cell: ({ row }) => <DeadlineBadge row={row.original} now={now} />,
  },
  { id: 'score', header: '점수', cell: ({ row }) => row.original.score ?? '-' },
]

export function CampaignTable({ rows, now }: { rows: CampaignRow[]; now?: Date }) {
  const table = useReactTable({
    data: rows,
    columns: columns(now),
    getCoreRowModel: getCoreRowModel(),
  })
  if (rows.length === 0) return <EmptyState>해당하는 체험단이 없어요.</EmptyState>
  return (
    <>
      <div className="hidden rounded-lg border bg-card md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((r) => (
              <TableRow key={r.id}>
                {r.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((c) => (
          <li key={c.id} className="rounded-lg border bg-card p-3">
            <Link
              to={`/campaigns/${c.id}`}
              className="block break-words text-sm font-medium text-primary"
            >
              #{c.id} {c.title || '(제목 없음)'}
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <Badge>{statusLabel(c.status)}</Badge>
              <span>{sourceLabel(c.source)}</span>
              <span>{c.brand ?? '-'}</span>
              <span>경쟁률 {formatCompetition(c.competition)}</span>
              <DeadlineBadge row={c} now={now} />
              <span>점수 {c.score ?? '-'}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

export function CampaignsPage() {
  const [params] = useSearchParams()
  const status = FILTER_CHIPS.some((c) => c.value === params.get('status'))
    ? (params.get('status') as string)
    : DEFAULT_STATUS
  const sourceParam = params.get('source')
  const source = isSource(sourceParam) ? sourceParam : null
  const q = useCampaigns(status, source)

  const href = (s: string, src: string | null) => {
    const p = new URLSearchParams()
    if (s !== DEFAULT_STATUS) p.set('status', s)
    if (src) p.set('source', src)
    const qs = p.toString()
    return qs ? `/campaigns?${qs}` : '/campaigns'
  }
  const sourceChips = [
    { value: null, label: '모든 출처' },
    ...SOURCES.map((s) => ({ value: s.key as string, label: s.label })),
  ]

  return (
    <>
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        체험단 {q.data && <Badge variant="outline">{q.data.rows.length}</Badge>}
      </h1>
      <div className="space-y-2">
        <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1" aria-label="출처 필터">
          {sourceChips.map((c) => (
            <Chip key={c.label} to={href(status, c.value)} on={c.value === source}>
              {c.label}
            </Chip>
          ))}
        </nav>
        <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1" aria-label="상태 필터">
          {FILTER_CHIPS.map((c) => (
            <Chip key={c.value} to={href(c.value, source)} on={c.value === status}>
              {c.label}
            </Chip>
          ))}
        </nav>
      </div>
      <QueryBoundary query={q}>{(data) => <CampaignTable rows={data.rows} />}</QueryBoundary>
      <p className="text-xs text-muted-foreground">
        마감이 가까운 순 · 선물하기 신청 마감은 남은 일수로 추정한 값
      </p>
    </>
  )
}
