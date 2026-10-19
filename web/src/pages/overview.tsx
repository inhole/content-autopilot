import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  FileEditIcon,
  GiftIcon,
  HourglassIcon,
  ListChecksIcon,
  SendIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { SourceDot } from '@/components/status-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  formatAge,
  formatDateTime,
  formatNumber,
  formatShortDateTime,
  SOURCES,
  truncate,
} from '@/lib/format.ts'
import { useOverview } from '@/lib/queries.ts'
import type { OverviewResponse } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

function Kpi({
  label,
  caption,
  value,
  to,
  icon: Icon,
  warn = false,
}: {
  label: string
  caption: string
  value: number
  to: string
  icon: LucideIcon
  warn?: boolean
}) {
  return (
    <Link
      to={to}
      className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card className="h-full gap-3 py-4 transition-colors hover:bg-accent/50">
        <CardHeader className="px-4">
          <CardDescription>{label}</CardDescription>
          <CardAction className="text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </CardAction>
          <CardTitle
            className={cn(
              'text-3xl font-semibold tabular-nums',
              warn && value > 0 && 'text-destructive',
            )}
          >
            {formatNumber(value)}
          </CardTitle>
        </CardHeader>
        <CardFooter className="px-4 text-xs text-muted-foreground">{caption}</CardFooter>
      </Card>
    </Link>
  )
}

const kpiGrid = 'grid grid-cols-2 gap-3 lg:grid-cols-4'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export function OverviewView({ data, now = new Date() }: { data: OverviewResponse; now?: Date }) {
  const p = data.posts
  const c = data.campaigns
  const n = (s: keyof typeof c.counts) => c.counts[s] ?? 0
  return (
    <div className="flex flex-col gap-8">
      <Section title="Threads">
        <div className={kpiGrid}>
          <Kpi
            label="검수 대기"
            caption="승인을 기다리는 초안"
            value={p.pendingReview}
            to="/posts"
            icon={ClipboardCheckIcon}
          />
          <Kpi
            label="발행 예정"
            caption="예약된 글"
            value={p.scheduled.length}
            to="/posts"
            icon={CalendarClockIcon}
          />
          <Kpi
            label="최근 24시간 발행"
            caption="지난 24시간 동안"
            value={p.published24h}
            to="/posts"
            icon={SendIcon}
          />
          <Kpi
            label="실패"
            caption="재시도나 확인이 필요한 글"
            value={p.failed}
            to="/posts"
            icon={TriangleAlertIcon}
            warn
          />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>발행 예정</CardTitle>
            <CardDescription>예약 시각은 한국 시간 기준</CardDescription>
          </CardHeader>
          <CardContent>
            {p.scheduled.length === 0 ? (
              <EmptyState
                title="발행 예정인 글이 없어요."
                description="승인된 글이 슬롯에 배정되면 여기에 보여요."
                icon={CalendarClockIcon}
              />
            ) : (
              <ul className="flex flex-col">
                {p.scheduled.map((s, i) => (
                  <li key={s.id}>
                    {i > 0 && <Separator />}
                    <div className="flex items-baseline gap-4 py-2.5 text-sm">
                      <time
                        dateTime={s.scheduled_at}
                        className="w-28 shrink-0 font-medium tabular-nums"
                      >
                        {formatShortDateTime(s.scheduled_at)}
                      </time>
                      <span className="min-w-0 truncate" title={s.text}>
                        {truncate(s.text, 60)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section title="체험단">
        <div className={cn(kpiGrid, 'lg:grid-cols-5')}>
          <Kpi
            label="검수 대기"
            caption="신청 여부를 정할 카드"
            value={n('PENDING_REVIEW')}
            to="/campaigns?status=PENDING_REVIEW"
            icon={ClipboardCheckIcon}
          />
          <Kpi
            label="신청함"
            caption="결과 대기"
            value={n('APPLIED')}
            to="/campaigns?status=APPLIED"
            icon={HourglassIcon}
          />
          <Kpi
            label="선정"
            caption="리뷰 전"
            value={n('SELECTED')}
            to="/campaigns?status=SELECTED"
            icon={CheckCircle2Icon}
          />
          <Kpi
            label="리뷰 초안"
            caption="작성 중인 초안"
            value={n('DRAFT_REVIEW')}
            to="/campaigns?status=DRAFT_REVIEW"
            icon={FileEditIcon}
          />
          <Kpi
            label="리뷰 완료"
            caption="최근 30일"
            value={c.postedLast30d}
            to="/campaigns?status=POSTED"
            icon={ListChecksIcon}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {SOURCES.map((s) => {
            const m = c.bySource?.[s.key] ?? {}
            const total = Object.values(m).reduce((a, b) => a + (b ?? 0), 0)
            const active =
              (m.PENDING_REVIEW ?? 0) + (m.APPLIED ?? 0) + (m.SELECTED ?? 0) + (m.DRAFT_REVIEW ?? 0)
            return (
              <Link
                key={s.key}
                to={`/campaigns?source=${s.key}`}
                aria-label={`${s.label} 진행 중 ${active}건, 전체 ${total}건`}
                className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full gap-3 py-4 transition-colors hover:bg-accent/50">
                  <CardHeader className="px-4">
                    <CardDescription className="flex items-center gap-2">
                      <SourceDot source={s.key} />
                      {s.label}
                    </CardDescription>
                    <CardAction className="text-muted-foreground">
                      <ArrowUpRightIcon className="size-4" aria-hidden="true" />
                    </CardAction>
                    <CardTitle className="text-3xl font-semibold tabular-nums">
                      {formatNumber(active)}
                    </CardTitle>
                  </CardHeader>
                  <CardFooter className="px-4 text-xs text-muted-foreground">
                    진행 중 · 전체 {formatNumber(total)}건
                  </CardFooter>
                </Card>
              </Link>
            )
          })}
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardDescription>마지막 수집</CardDescription>
              <CardAction className="text-muted-foreground">
                <GiftIcon className="size-4" aria-hidden="true" />
              </CardAction>
              {c.lastCollectedAt ? (
                <CardTitle className="text-lg font-semibold tabular-nums">
                  {formatDateTime(c.lastCollectedAt)}
                </CardTitle>
              ) : (
                <CardTitle className="text-lg font-medium text-muted-foreground">
                  아직 수집한 체험단이 없어요.
                </CardTitle>
              )}
            </CardHeader>
            {c.lastCollectedAt && (
              <CardFooter className="gap-2 px-4 text-xs text-muted-foreground">
                <Badge variant="muted">{formatAge(c.lastCollectedAt, now)}</Badge>
                <span>그때 확인한 체험단 {formatNumber(c.lastSeenCount)}건</span>
              </CardFooter>
            )}
          </Card>
        </div>
      </Section>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-8" role="status" aria-label="불러오는 중">
      {[4, 5].map((count) => (
        <div key={count} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-20" />
          <div className={cn(kpiGrid, count === 5 && 'lg:grid-cols-5')}>
            {Array.from({ length: count }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ))}
    </div>
  )
}

export function OverviewPage() {
  const q = useOverview()
  return (
    <>
      <PageHeader title="현황" description="Threads 발행과 체험단 진행 상황 · 60초마다 새로고침" />
      <QueryBoundary query={q} skeleton={<OverviewSkeleton />}>
        {(data) => <OverviewView data={data} />}
      </QueryBoundary>
    </>
  )
}
