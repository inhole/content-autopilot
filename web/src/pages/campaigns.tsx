import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GiftIcon,
  SearchIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import {
  CampaignStatusBadge,
  DeadlineBadge,
  SourceDot,
  SourceLabel,
} from '@/components/status-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx'
import { formatCompetition, SOURCES, statusLabel } from '@/lib/format.ts'
import { useCampaigns } from '@/lib/queries.ts'
import type { CampaignRow } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

export const DEFAULT_STATUS = 'active'

/** Statuses shown as tabs; the rest sit behind the "기타 상태" select. */
const TAB_STATUSES = ['active', 'all', 'PENDING_REVIEW', 'APPLIED', 'SELECTED', 'DRAFT_REVIEW', 'POSTED']
const OTHER_STATUSES = ['NOT_SELECTED', 'REJECTED', 'EXPIRED', 'SKIPPED', 'SHORTLISTED', 'COLLECTED']
const ALL_STATUSES = [...TAB_STATUSES, ...OTHER_STATUSES]

const filterLabel = (v: string) => (v === 'active' ? '진행 중' : v === 'all' ? '전체' : statusLabel(v))

type SourceKey = (typeof SOURCES)[number]['key']
const isSource = (v: string | null): v is SourceKey => SOURCES.some((s) => s.key === v)

const PAGE_SIZE = 20

type ListState = { background?: unknown }

/** Link to the detail that opens as a sheet over the list (filters stay in the query string). */
export function useCampaignLink() {
  const location = useLocation()
  return (id: number) => ({
    to: { pathname: `/campaigns/${id}`, search: location.search },
    state: { background: location } satisfies ListState,
  })
}

const byNumber = (get: (r: CampaignRow) => number | null | undefined) => (r: CampaignRow) =>
  get(r) ?? undefined

const columns = (now?: Date): ColumnDef<CampaignRow>[] => [
  {
    id: 'title',
    header: '제목',
    enableSorting: false,
    // The search text. TanStack only filters columns with an accessor, and by default decides
    // which ones from the first row's values, so the search needs a string accessor of its own.
    accessorFn: (r) => `${r.title ?? ''} ${r.brand ?? ''}`,
    cell: ({ row: { original: c } }) => <CampaignTitle row={c} />,
  },
  {
    id: 'source',
    header: '출처',
    enableSorting: false,
    cell: ({ row }) => <SourceLabel source={row.original.source} />,
  },
  {
    id: 'status',
    header: '상태',
    enableSorting: false,
    cell: ({ row }) => <CampaignStatusBadge status={row.original.status} />,
  },
  {
    id: 'competition',
    header: '경쟁률',
    accessorFn: byNumber((r) => r.competition),
    sortUndefined: 'last',
    meta: { align: 'right' },
    cell: ({ row }) => (
      <span className="tabular-nums">{formatCompetition(row.original.competition)}</span>
    ),
  },
  {
    id: 'deadline',
    header: '마감',
    accessorFn: byNumber((r) => (r.next_deadline ? Date.parse(r.next_deadline.at) : null)),
    sortUndefined: 'last',
    cell: ({ row }) => <DeadlineBadge row={row.original} now={now} />,
  },
  {
    id: 'score',
    header: '점수',
    accessorFn: byNumber((r) => r.score),
    sortUndefined: 'last',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums">{row.original.score ?? '-'}</span>,
  },
]

function CampaignTitle({ row: c }: { row: CampaignRow }) {
  const link = useCampaignLink()(c.id)
  return (
    <div className="flex min-w-0 max-w-md flex-col gap-0.5">
      <Link {...link} className="truncate font-medium underline-offset-4 hover:underline">
        #{c.id} {c.title || '(제목 없음)'}
      </Link>
      {c.brand && <span className="truncate text-xs text-muted-foreground">{c.brand}</span>}
    </div>
  )
}

function SortHeader({
  label,
  sorted,
  onToggle,
  align,
}: {
  label: string
  sorted: false | 'asc' | 'desc'
  onToggle: () => void
  align?: 'right'
}) {
  const Icon = sorted === 'asc' ? ArrowUpIcon : sorted === 'desc' ? ArrowDownIcon : ChevronsUpDownIcon
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className={cn('-ml-2 h-8 px-2', align === 'right' && 'ml-auto -mr-2')}
    >
      {label}
      <Icon data-icon="inline-end" className={cn(!sorted && 'text-muted-foreground')} />
    </Button>
  )
}

const ariaSort = (s: false | 'asc' | 'desc') =>
  s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : undefined

export function CampaignTable({ rows, now }: { rows: CampaignRow[]; now?: Date }) {
  const navigate = useNavigate()
  const campaignLink = useCampaignLink()
  const [sorting, setSorting] = useState<SortingState>([])
  const [search, setSearch] = useState('')
  const table = useReactTable({
    data: rows,
    columns: columns(now),
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    // Search title and brand only, whatever the first row's numeric columns hold.
    getColumnCanGlobalFilter: (column) => column.id === 'title',
    globalFilterFn: (row, _id, value: string) => {
      const needle = String(value).trim().toLowerCase()
      const c = row.original
      return `${c.title ?? ''} ${c.brand ?? ''}`.toLowerCase().includes(needle)
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  })
  if (rows.length === 0) {
    return <EmptyState title="해당하는 체험단이 없어요." icon={GiftIcon} />
  }

  const pageRows = table.getRowModel().rows
  const total = table.getFilteredRowModel().rows.length
  const { pageIndex } = table.getState().pagination
  const pageCount = table.getPageCount()

  const openRow = (c: CampaignRow, target: EventTarget) => {
    if (target instanceof Element && target.closest('a, button')) return
    const l = campaignLink(c.id)
    navigate(l.to, { state: l.state })
  }

  return (
    <div className="flex flex-col gap-3">
      <InputGroup className="max-w-sm">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="제목·브랜드 검색"
          aria-label="제목·브랜드 검색"
        />
      </InputGroup>

      {pageRows.length === 0 ? (
        <EmptyState title="검색 결과가 없어요." description="다른 검색어를 입력해 보세요." icon={SearchIcon} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="hover:bg-transparent">
                    {hg.headers.map((h) => {
                      const right = (h.column.columnDef.meta as { align?: 'right' } | undefined)
                        ?.align
                      const sorted = h.column.getIsSorted()
                      return (
                        <TableHead
                          key={h.id}
                          aria-sort={ariaSort(sorted)}
                          className={cn(right && 'text-right')}
                        >
                          {h.column.getCanSort() ? (
                            <SortHeader
                              label={String(h.column.columnDef.header)}
                              sorted={sorted}
                              onToggle={() => h.column.toggleSorting(sorted === 'asc')}
                              align={right}
                            />
                          ) : (
                            flexRender(h.column.columnDef.header, h.getContext())
                          )}
                        </TableHead>
                      )
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={(e) => openRow(r.original, e.target)}
                  >
                    {r.getVisibleCells().map((cell) => {
                      const right = (cell.column.columnDef.meta as { align?: 'right' } | undefined)
                        ?.align
                      return (
                        <TableCell key={cell.id} className={cn(right && 'text-right')}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden">
            {pageRows.map(({ original: c }) => (
              <li key={c.id}>
                <div
                  className="flex flex-col gap-2 rounded-xl border bg-card p-3"
                  onClick={(e) => openRow(c, e.target)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <CampaignTitle row={c} />
                    <CampaignStatusBadge status={c.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <SourceLabel source={c.source} />
                    <span className="tabular-nums">경쟁률 {formatCompetition(c.competition)}</span>
                    <span className="tabular-nums">점수 {c.score ?? '-'}</span>
                    <DeadlineBadge row={c} now={now} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {total}건{pageCount > 1 && ` · ${pageIndex + 1} / ${pageCount} 쪽`}
        </span>
        {pageCount > 1 && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeftIcon data-icon="inline-start" />
              이전
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              다음
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function CampaignsSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="불러오는 중">
      <Skeleton className="h-9 w-full max-w-sm" />
      <div className="overflow-hidden rounded-xl border">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none border-b" />
        ))}
      </div>
    </div>
  )
}

export function CampaignsPage() {
  const [params, setParams] = useSearchParams()
  const statusParam = params.get('status')
  const status =
    statusParam && ALL_STATUSES.includes(statusParam) ? statusParam : DEFAULT_STATUS
  const sourceParam = params.get('source')
  const source = isSource(sourceParam) ? sourceParam : null
  const q = useCampaigns(status, source)

  const update = (nextStatus: string, nextSource: string | null) => {
    const p = new URLSearchParams()
    if (nextStatus !== DEFAULT_STATUS) p.set('status', nextStatus)
    if (nextSource) p.set('source', nextSource)
    setParams(p, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="체험단"
        description="마감이 가까운 순 · 선물하기 신청 마감은 남은 일수로 추정한 값"
      >
        {q.data && (
          <Badge variant="outline" className="tabular-nums">
            {q.data.rows.length}건
          </Badge>
        )}
      </PageHeader>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={source ?? 'all'}
            onValueChange={(v) => v && update(status, v === 'all' ? null : v)}
            aria-label="출처 필터"
          >
            <ToggleGroupItem value="all">모든 출처</ToggleGroupItem>
            {SOURCES.map((s) => (
              <ToggleGroupItem key={s.key} value={s.key}>
                <SourceDot source={s.key} className="mr-1.5" />
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-2">
          {/* Scrolls sideways on narrow screens; no vertical overflow, no visible scrollbar. */}
          <div className="min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Tabs
              value={TAB_STATUSES.includes(status) ? status : ''}
              onValueChange={(v) => update(v, source)}
            >
              <TabsList aria-label="상태 필터">
                {TAB_STATUSES.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {filterLabel(s)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <Select
            value={OTHER_STATUSES.includes(status) ? status : ''}
            onValueChange={(v) => update(v, source)}
          >
            <SelectTrigger size="sm" className="shrink-0" aria-label="기타 상태">
              <SelectValue placeholder="기타 상태" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {OTHER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {filterLabel(s)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <QueryBoundary query={q} skeleton={<CampaignsSkeleton />}>
        {(data) => <CampaignTable rows={data.rows} />}
      </QueryBoundary>
    </>
  )
}
