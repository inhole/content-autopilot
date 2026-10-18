import { Link } from 'react-router-dom'
import { EmptyState, ListSkeleton, QueryBoundary } from '@/components/query-state.tsx'
import { Card, CardContent } from '@/components/ui/card.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { formatAge, formatDateTime, SOURCES, truncate } from '@/lib/format.ts'
import { useOverview } from '@/lib/queries.ts'
import type { OverviewResponse } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

function Stat({
  label,
  value,
  to,
  warn = false,
}: {
  label: string
  value: number
  to: string
  warn?: boolean
}) {
  return (
    <Link
      to={to}
      className="flex flex-col rounded-lg border bg-card p-3 transition-colors hover:bg-muted"
    >
      <b className={cn('text-2xl tabular-nums', warn && value > 0 && 'text-destructive')}>
        {value}
      </b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  )
}

const grid = 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'

export function OverviewView({ data, now = new Date() }: { data: OverviewResponse; now?: Date }) {
  const p = data.posts
  const c = data.campaigns
  const n = (s: keyof typeof c.counts) => c.counts[s] ?? 0
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Threads</h2>
        <div className={grid}>
          <Stat label="검수 대기" value={p.pendingReview} to="/posts" />
          <Stat label="발행 예정" value={p.scheduled.length} to="/posts" />
          <Stat label="최근 24시간 발행" value={p.published24h} to="/posts" />
          <Stat label="실패" value={p.failed} to="/posts" warn />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">발행 예정</h2>
        {p.scheduled.length === 0 ? (
          <EmptyState>발행 예정인 글이 없어요.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {p.scheduled.map((s) => (
              <li key={s.id} className="rounded-lg border bg-card p-3 text-sm">
                <b className="mr-2 tabular-nums">{formatDateTime(s.scheduled_at)}</b>
                <span className="break-words">{truncate(s.text, 60)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">체험단</h2>
        <div className={grid}>
          <Stat
            label="검수 대기"
            value={n('PENDING_REVIEW')}
            to="/campaigns?status=PENDING_REVIEW"
          />
          <Stat label="신청함·결과 대기" value={n('APPLIED')} to="/campaigns?status=APPLIED" />
          <Stat label="선정·리뷰 전" value={n('SELECTED')} to="/campaigns?status=SELECTED" />
          <Stat label="리뷰 초안" value={n('DRAFT_REVIEW')} to="/campaigns?status=DRAFT_REVIEW" />
          <Stat label="최근 30일 리뷰 완료" value={c.postedLast30d} to="/campaigns?status=POSTED" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">출처별</h2>
        <div className={grid}>
          {SOURCES.map((s) => {
            const m = c.bySource?.[s.key] ?? {}
            const total = Object.values(m).reduce((a, b) => a + (b ?? 0), 0)
            const active =
              (m.PENDING_REVIEW ?? 0) + (m.APPLIED ?? 0) + (m.SELECTED ?? 0) + (m.DRAFT_REVIEW ?? 0)
            return (
              <Stat
                key={s.key}
                label={`${s.label} 진행 중 (전체 ${total})`}
                value={active}
                to={`/campaigns?source=${s.key}`}
              />
            )
          })}
        </div>
        <Card>
          <CardContent className="p-3 text-sm">
            {c.lastCollectedAt ? (
              <>
                마지막 수집 <b>{formatDateTime(c.lastCollectedAt)}</b> (
                {formatAge(c.lastCollectedAt, now)}) · 그때 확인한 체험단 {c.lastSeenCount}건
              </>
            ) : (
              <span className="text-muted-foreground">아직 수집한 체험단이 없어요.</span>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="불러오는 중">
      <div className={grid}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
      <ListSkeleton rows={3} />
    </div>
  )
}

export function OverviewPage() {
  const q = useOverview()
  return (
    <>
      <h1 className="text-lg font-semibold">현황</h1>
      <QueryBoundary query={q} skeleton={<OverviewSkeleton />}>
        {(data) => <OverviewView data={data} />}
      </QueryBoundary>
      <p className="text-xs text-muted-foreground">60초마다 새로고침 · 시각은 한국 시간</p>
    </>
  )
}
