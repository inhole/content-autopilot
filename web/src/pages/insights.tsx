import { useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import { formatDateTime, formatNumber, truncate } from '@/lib/format.ts'
import { useInsights } from '@/lib/queries.ts'
import type { InsightsResponse } from '@/lib/types.ts'
import { Chip } from './campaigns.tsx'

const RANGES = [7, 30, 90]

const METRICS = [
  { key: 'views', label: '조회', color: 'var(--chart-1)' },
  { key: 'likes', label: '좋아요', color: 'var(--chart-2)' },
  { key: 'replies', label: '답글', color: 'var(--chart-3)' },
] as const

const shortDate = (d: string) => d.slice(5)

export function InsightsView({ data }: { data: InsightsResponse }) {
  const hasData = data.daily.some((d) => d.posts > 0)
  return (
    <div className="space-y-5">
      {!hasData ? (
        <EmptyState>이 기간에 발행한 글의 반응이 아직 없어요.</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {METRICS.map((m) => {
            const config: ChartConfig = { [m.key]: { label: m.label, color: m.color } }
            const total = data.daily.reduce((a, d) => a + d[m.key], 0)
            return (
              <Card key={m.key}>
                <CardHeader>
                  <CardTitle>
                    일별 {m.label}{' '}
                    <span className="font-normal text-muted-foreground">
                      합계 {formatNumber(total)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={config}>
                    <BarChart data={data.daily} margin={{ left: -16, right: 4, top: 4 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={shortDate}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={24}
                      />
                      <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey={m.key} fill={`var(--color-${m.key})`} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">조회수 상위 글</h2>
        {data.top.length === 0 ? (
          <EmptyState>아직 집계된 글이 없어요.</EmptyState>
        ) : (
          <div className="rounded-lg border bg-card">
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
                    <TableCell className="min-w-48 break-words">{truncate(t.text, 80)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDateTime(t.published_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(t.views)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(t.likes)}
                    </TableCell>
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
          </div>
        )}
      </section>
    </div>
  )
}

export function InsightsPage() {
  const [params] = useSearchParams()
  const requested = Number(params.get('days'))
  const days = RANGES.includes(requested) ? requested : 30
  const q = useInsights(days)
  return (
    <>
      <h1 className="text-lg font-semibold">성과</h1>
      <nav className="flex gap-1.5" aria-label="기간">
        {RANGES.map((r) => (
          <Chip key={r} to={`/insights?days=${r}`} on={r === days}>
            {r}일
          </Chip>
        ))}
      </nav>
      <QueryBoundary query={q}>{(data) => <InsightsView data={data} />}</QueryBoundary>
    </>
  )
}
