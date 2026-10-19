import { BarChart3Icon } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart.tsx'
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
import { formatNumber, formatShortDateTime, truncate } from '@/lib/format.ts'
import { useInsights } from '@/lib/queries.ts'
import type { InsightsResponse } from '@/lib/types.ts'

const RANGES = [7, 30, 90]

const METRICS = {
  views: { label: '조회', color: 'var(--chart-1)' },
  likes: { label: '좋아요', color: 'var(--chart-2)' },
  replies: { label: '답글', color: 'var(--chart-3)' },
} as const

type Metric = keyof typeof METRICS

const shortDate = (d: string) => d.slice(5)

function MetricChart({
  daily,
  metric,
  height = 'h-64',
}: {
  daily: InsightsResponse['daily']
  metric: Metric
  height?: string
}) {
  const m = METRICS[metric]
  const config: ChartConfig = { [metric]: { label: m.label, color: m.color } }
  return (
    <ChartContainer config={config} className={`aspect-auto w-full ${height}`}>
      <AreaChart data={daily} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDate}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
        />
        <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => String(v)}
              indicator="line"
            />
          }
        />
        <Area
          dataKey={metric}
          type="monotone"
          stroke={`var(--color-${metric})`}
          fill={`var(--color-${metric})`}
          fillOpacity={0.15}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function InsightsView({ data }: { data: InsightsResponse }) {
  const [metric, setMetric] = useState<'likes' | 'replies'>('likes')
  const hasData = data.daily.some((d) => d.posts > 0)
  const sum = (k: 'posts' | 'views' | 'likes' | 'replies') =>
    data.daily.reduce((a, d) => a + d[k], 0)
  const totals: { key: 'posts' | Metric; label: string }[] = [
    { key: 'posts', label: '발행한 글' },
    { key: 'views', label: '조회' },
    { key: 'likes', label: '좋아요' },
    { key: 'replies', label: '답글' },
  ]
  return (
    <div className="flex flex-col gap-6">
      {!hasData ? (
        <EmptyState
          title="이 기간에 발행한 글의 반응이 아직 없어요."
          description="글이 발행되고 지표가 수집되면 여기에 그래프가 나타나요."
          icon={BarChart3Icon}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {totals.map((t) => (
              <Card key={t.key} className="gap-1 py-4">
                <CardHeader className="px-4">
                  <CardDescription>{t.label}</CardDescription>
                  <CardTitle className="text-2xl font-semibold tabular-nums">
                    {formatNumber(sum(t.key))}
                  </CardTitle>
                </CardHeader>
                <CardFooter className="px-4 text-xs text-muted-foreground">
                  최근 {data.days}일 합계
                </CardFooter>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>일별 조회</CardTitle>
              <CardDescription>
                발행일 기준 · 각 글의 최신 수집값 합계 (합계 {formatNumber(sum('views'))})
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MetricChart daily={data.daily} metric="views" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>일별 {METRICS[metric].label}</CardTitle>
              <CardDescription>
                발행일 기준 (합계 {formatNumber(sum(metric))})
              </CardDescription>
              <CardAction>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={metric}
                  onValueChange={(v) => v && setMetric(v as 'likes' | 'replies')}
                  aria-label="지표"
                >
                  <ToggleGroupItem value="likes">좋아요</ToggleGroupItem>
                  <ToggleGroupItem value="replies">답글</ToggleGroupItem>
                </ToggleGroup>
              </CardAction>
            </CardHeader>
            <CardContent>
              <MetricChart daily={data.daily} metric={metric} height="h-48" />
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>조회수 상위 글</CardTitle>
          <CardDescription>선택한 기간에 발행한 글 중 조회수가 많은 순</CardDescription>
        </CardHeader>
        <CardContent>
          {data.top.length === 0 ? (
            <EmptyState title="아직 집계된 글이 없어요." icon={BarChart3Icon} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>내용</TableHead>
                  <TableHead>발행</TableHead>
                  <TableHead className="text-right">조회</TableHead>
                  <TableHead className="text-right">좋아요</TableHead>
                  <TableHead className="text-right">답글</TableHead>
                  <TableHead className="text-right">리포스트</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.top.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-xs min-w-48">
                      <span className="block truncate" title={t.text}>
                        {truncate(t.text, 80)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatShortDateTime(t.published_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(t.views)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(t.likes)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(t.replies)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(t.reposts)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="불러오는 중">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  )
}

export function InsightsPage() {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('days'))
  const days = RANGES.includes(requested) ? requested : 30
  const q = useInsights(days)
  return (
    <>
      <PageHeader title="성과" description="발행한 글의 조회·좋아요·답글 · 날짜는 한국 시간 기준">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={String(days)}
          onValueChange={(v) => v && setParams({ days: v }, { replace: true })}
          aria-label="기간"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r} value={String(r)}>
              {r}일
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PageHeader>
      <QueryBoundary query={q} skeleton={<InsightsSkeleton />}>
        {(data) => <InsightsView data={data} />}
      </QueryBoundary>
    </>
  )
}
