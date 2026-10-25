import { ChevronRightIcon, CalendarCheck2Icon, InboxIcon } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { SourceDot } from '@/components/status-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  daysUntil,
  formatAge,
  formatDday,
  formatNumber,
  formatShortDateTime,
  formatTime,
  kstDay,
  SOURCES,
  TZ,
  truncate,
} from '@/lib/format.ts'
import { useCampaigns, useOps, useOverview, useVideos } from '@/lib/queries.ts'
import { deadlineTone } from '@/lib/status.ts'
import type { CampaignRow, OverviewResponse } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'
import { useCampaignLink } from '@/pages/campaigns.tsx'
import { usePostLink } from '@/pages/posts.tsx'

/* ------------------------------------------------------------------ what needs the owner */

type Tone = 'danger' | 'act' | 'wait'

type Task = { key: string; count: number; label: string; hint: string; to: string; tone: Tone }

/** Decisions waiting for the owner, most urgent first; only the ones with something to do. */
export function tasksOf(data: OverviewResponse, videosWaiting = 0): Task[] {
  const n = (s: keyof OverviewResponse['campaigns']['counts']) => data.campaigns.counts[s] ?? 0
  const all: Task[] = [
    {
      key: 'failed',
      count: data.posts.failed,
      label: '발행 실패',
      hint: '원인을 확인하고 다시 발행해요',
      to: '/posts?status=FAILED',
      tone: 'danger',
    },
    {
      key: 'posts',
      count: data.posts.pendingReview,
      label: 'Threads 초안 검수',
      hint: '48시간 안에 검수하지 않으면 만료돼요',
      to: '/posts?status=PENDING_REVIEW',
      tone: 'act',
    },
    {
      key: 'videos',
      count: videosWaiting,
      label: '영상 검수',
      hint: '승인하면 다음 영상 슬롯에 올라가요',
      to: '/videos',
      tone: 'act',
    },
    {
      key: 'apply',
      count: n('PENDING_REVIEW'),
      label: '체험단 신청 결정',
      hint: '신청할지 패스할지 정해요',
      to: '/campaigns?status=PENDING_REVIEW',
      tone: 'act',
    },
    {
      key: 'selected',
      count: n('SELECTED'),
      label: '리뷰 쓰기',
      hint: '선정됐어요. 메모를 남기면 초안을 써 드려요',
      to: '/campaigns?status=SELECTED',
      tone: 'act',
    },
    {
      key: 'draft',
      count: n('DRAFT_REVIEW'),
      label: '리뷰 초안 확인',
      hint: '초안을 다듬고, 올렸으면 리뷰 올림으로 표시해요',
      to: '/campaigns?status=DRAFT_REVIEW',
      tone: 'act',
    },
    {
      key: 'applied',
      count: n('APPLIED'),
      label: '선정 결과 기다리는 중',
      hint: '발표가 나면 선정·미선정을 기록해요',
      to: '/campaigns?status=APPLIED',
      tone: 'wait',
    },
  ]
  return all.filter((t) => t.count > 0)
}

/** Only a failure gets a mark at the edge; everything else is told apart by its number. */
const TONE_BAR: Record<Tone, string> = {
  danger: 'before:bg-destructive',
  act: 'before:bg-transparent',
  wait: 'before:bg-transparent',
}

function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        title="지금 결정할 일이 없어요."
        description="새 초안이나 체험단 카드가 오면 여기에 모여요."
        icon={InboxIcon}
      />
    )
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      {tasks.map((t) => (
        <li key={t.key}>
          <Link
            to={t.to}
            className={cn(
              'relative grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-3 py-2.5 pr-3 pl-4 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
              'before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-r-full',
              TONE_BAR[t.tone],
            )}
          >
            <span
              className={cn(
                'font-display text-2xl leading-none font-semibold tabular-nums',
                t.tone === 'danger' && 'text-destructive',
                t.tone === 'wait' && 'text-muted-foreground',
              )}
            >
              {formatNumber(t.count)}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{t.label}</span>
              <span className="text-xs text-muted-foreground">{t.hint}</span>
            </span>
            <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ campaign deadlines */

/** Active campaigns whose current-stage deadline falls within `withinDays`, soonest first. */
export function upcomingDeadlines(
  rows: CampaignRow[],
  now: Date = new Date(),
  withinDays = 7,
  max = 6,
): CampaignRow[] {
  return rows
    .filter((r) => {
      if (!r.next_deadline) return false
      const d = daysUntil(r.next_deadline.at, now)
      return d >= 0 && d <= withinDays
    })
    .sort((a, b) => Date.parse(a.next_deadline?.at ?? '') - Date.parse(b.next_deadline?.at ?? ''))
    .slice(0, max)
}

const deadlineKind = (d: NonNullable<CampaignRow['next_deadline']>) =>
  `${d.kind === 'review' ? '리뷰 마감' : '신청 마감'}${d.estimated ? ' (추정)' : ''}`

function DeadlineRow({ row, now }: { row: CampaignRow; now?: Date }) {
  const link = useCampaignLink()(row.id)
  const d = row.next_deadline
  if (!d) return null
  const days = daysUntil(d.at, now)
  return (
    <li>
      <Link
        {...link}
        className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <Badge variant={deadlineTone(days)} className="justify-self-start tabular-nums">
          {formatDday(days)}
        </Badge>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={row.title ?? undefined}>
            {row.title || '(제목 없음)'}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SourceDot source={row.source} />
            {deadlineKind(d)}
          </span>
        </span>
      </Link>
    </li>
  )
}

export function DeadlineList({ rows, now }: { rows: CampaignRow[]; now?: Date }) {
  const soon = upcomingDeadlines(rows, now)
  if (soon.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        7일 안에 다가오는 마감이 없어요.
      </p>
    )
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      {soon.map((r) => (
        <DeadlineRow key={r.id} row={r} now={now} />
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ the publishing schedule */

type Scheduled = OverviewResponse['posts']['scheduled'][number]

type Entry =
  /** `due`: its time has passed and it has not gone out yet (the sweep runs every 5 minutes). */
  | { kind: 'post'; time: string; post: Scheduled; due: boolean }
  | { kind: 'empty'; time: string }

type ScheduleDay = { day: string; label: string; entries: Entry[] }

const dayLabelFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: TZ,
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})

/**
 * Today and tomorrow (KST): every publish slot still ahead, filled by the post scheduled at that
 * time or marked empty, plus posts scheduled off-slot (publish-now). Slots already past today are
 * left out: whether they went out is the posts list's business. Posts whose time has passed (from
 * any day) open today's list as `due` and never fill a slot. `later` counts posts after tomorrow.
 */
export function buildSchedule(
  scheduled: Scheduled[],
  slots: string[] | null,
  now: Date = new Date(),
): { days: ScheduleDay[]; later: number } {
  const today = kstDay(now)
  const tomorrow = kstDay(new Date(now.getTime() + 86_400_000))
  const nowTime = formatTime(now)
  const days: ScheduleDay[] = [
    { day: today, label: `오늘 ${dayLabelFormat.format(now)}`, entries: [] },
    {
      day: tomorrow,
      label: `내일 ${dayLabelFormat.format(new Date(now.getTime() + 86_400_000))}`,
      entries: [],
    },
  ]
  let later = 0
  const due: Entry[] = []
  for (const post of scheduled) {
    const at = new Date(post.scheduled_at)
    const time = formatTime(at)
    if (at.getTime() <= now.getTime()) {
      due.push({ kind: 'post', time, post, due: true })
      continue
    }
    const day = kstDay(at)
    const target = day === today ? days[0] : day === tomorrow ? days[1] : null
    if (!target) later++
    else target.entries.push({ kind: 'post', time, post, due: false })
  }
  for (const d of days) {
    for (const slot of slots ?? []) {
      if (d.entries.some((e) => e.time === slot)) continue
      if (d.day === today && slot <= nowTime) continue
      d.entries.push({ kind: 'empty', time: slot })
    }
    d.entries.sort((a, b) => a.time.localeCompare(b.time))
  }
  due.sort((a, b) =>
    a.kind === 'post' && b.kind === 'post'
      ? Date.parse(a.post.scheduled_at) - Date.parse(b.post.scheduled_at)
      : 0,
  )
  days[0]?.entries.unshift(...due)
  return { days, later }
}

function NowMarker({ time }: { time: string }) {
  return (
    <li className="relative h-0" aria-label={`지금 ${time}`}>
      <span aria-hidden="true" className="absolute inset-x-0 -top-px h-0.5 bg-primary" />
      <span
        aria-hidden="true"
        className="absolute -top-2.5 right-0 rounded-sm bg-card px-1.5 text-[11px] leading-5 font-semibold text-primary tabular-nums"
      >
        지금 {time}
      </span>
    </li>
  )
}

/** A due post more than this late is flagged: publish-due should have picked it up by now. */
const LATE_MS = 15 * 60_000

function EntryRow({ entry, now }: { entry: Entry; now: Date }) {
  const postLink = usePostLink()
  const late =
    entry.kind === 'post' &&
    entry.due &&
    now.getTime() - Date.parse(entry.post.scheduled_at) > LATE_MS
  return (
    <li className="grid grid-cols-[4.25rem_minmax(0,1fr)] border-b border-grid/50">
      <time
        className={cn(
          'border-r border-grid/50 py-2.5 font-display text-lg leading-6 font-semibold tabular-nums',
          (entry.kind === 'empty' || entry.due) && 'text-muted-foreground',
        )}
      >
        {entry.time}
      </time>
      <div className="min-w-0 py-2.5 pl-3 text-sm leading-6">
        {entry.kind === 'post' ? (
          <>
            {entry.due && (
              <span className={cn('block text-xs', late ? 'text-warning' : 'text-muted-foreground')}>
                {late
                  ? `${formatShortDateTime(entry.post.scheduled_at)} 예정, 아직 나가지 않았어요`
                  : '발행 차례를 기다리는 중'}
              </span>
            )}
            <Link
              {...postLink(entry.post.id)}
              className="line-clamp-2 underline-offset-4 hover:underline"
              title={entry.post.text}
            >
              {truncate(entry.post.text, 90)}
            </Link>
          </>
        ) : (
          <span className="text-muted-foreground">비어 있음</span>
        )}
      </div>
    </li>
  )
}

export function ScheduleBoard({
  scheduled,
  slots,
  now = new Date(),
}: {
  scheduled: Scheduled[]
  slots: string[] | null
  now?: Date
}) {
  const { days, later } = buildSchedule(scheduled, slots, now)
  const nowTime = formatTime(now)
  if (days.every((d) => d.entries.length === 0) && later === 0) {
    return (
      <EmptyState
        title="발행 예정인 글이 없어요."
        description="승인된 글이 슬롯에 배정되면 여기에 보여요."
        icon={CalendarCheck2Icon}
      />
    )
  }
  return (
    <div className="flex flex-col gap-5 rounded-xl border bg-card px-4 pt-3 pb-4">
      {days.map((d, i) => {
        // The now line sits after the due posts (today only); everything else is still ahead.
        const cut = i === 0 ? d.entries.filter((e) => e.kind === 'post' && e.due).length : -1
        return (
          <div key={d.day} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{d.label}</h3>
            {d.entries.length === 0 ? (
              <p className="border-y border-grid/50 py-2.5 text-sm text-muted-foreground">
                {i === 0 ? '오늘 남은 예약과 슬롯이 없어요.' : '예약된 글이 없어요.'}
              </p>
            ) : (
              <ol className="border-t border-grid/50">
                {d.entries.map((e, j) => (
                  <Fragment key={`${e.time}-${e.kind === 'post' ? e.post.id : 'slot'}`}>
                    {j === cut && <NowMarker time={nowTime} />}
                    <EntryRow entry={e} now={now} />
                  </Fragment>
                ))}
                {cut === d.entries.length && <NowMarker time={nowTime} />}
              </ol>
            )}
          </div>
        )
      })}
      {later > 0 && (
        <Link
          to="/posts?status=SCHEDULED"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          모레 이후 예약 {later}건 더 보기
        </Link>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the quiet record */

function Record({
  label,
  value,
  caption,
  to,
  ariaLabel,
}: {
  label: ReactNode
  value: ReactNode
  caption?: ReactNode
  to?: string
  ariaLabel?: string
}) {
  const body = (
    <>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex flex-col gap-0.5">
        <span className="text-xl font-semibold tabular-nums">{value}</span>
        {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      </dd>
    </>
  )
  // Five records: the last one takes the leftover width on two and three columns alike.
  const cell = 'flex flex-col px-4 py-3 last:col-span-2'
  return to ? (
    <Link
      to={to}
      aria-label={ariaLabel}
      className={cn(
        cell,
        'outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
      )}
    >
      <dl>{body}</dl>
    </Link>
  ) : (
    <dl className={cell}>{body}</dl>
  )
}

function RecordBand({ data, now }: { data: OverviewResponse; now?: Date }) {
  const c = data.campaigns
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 [&>*]:bg-card">
      <Record label="최근 24시간 발행" value={formatNumber(data.posts.published24h)} caption="Threads 글" />
      <Record
        label="리뷰 완료"
        value={formatNumber(c.postedLast30d)}
        caption="최근 30일"
        to="/campaigns?status=POSTED"
      />
      {SOURCES.map((s) => {
        const m = c.bySource?.[s.key] ?? {}
        const total = Object.values(m).reduce((a, b) => a + (b ?? 0), 0)
        const active =
          (m.PENDING_REVIEW ?? 0) + (m.APPLIED ?? 0) + (m.SELECTED ?? 0) + (m.DRAFT_REVIEW ?? 0)
        return (
          <Record
            key={s.key}
            to={`/campaigns?source=${s.key}`}
            ariaLabel={`${s.label} 진행 중 ${active}건, 전체 ${total}건`}
            label={
              <>
                <SourceDot source={s.key} />
                {s.label} 진행 중
              </>
            }
            value={formatNumber(active)}
            caption={`전체 ${formatNumber(total)}건`}
          />
        )
      })}
      <Record
        label="마지막 수집"
        value={c.lastCollectedAt ? formatAge(c.lastCollectedAt, now) : '-'}
        caption={
          c.lastCollectedAt
            ? `그때 확인한 체험단 ${formatNumber(c.lastSeenCount)}건`
            : '아직 수집한 체험단이 없어요.'
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ page */

function Section({
  title,
  aside,
  children,
  className,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

export function OverviewView({
  data,
  now = new Date(),
  slots = null,
  videosWaiting = 0,
  deadlines,
}: {
  data: OverviewResponse
  now?: Date
  /** PUBLISH_SLOTS in effect; null when unknown (only scheduled posts are shown). */
  slots?: string[] | null
  videosWaiting?: number
  /** Body of the deadline section (the campaign list loads separately); omitted when absent. */
  deadlines?: ReactNode
}) {
  const tasks = tasksOf(data, videosWaiting)
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-x-8">
      <div className="flex min-w-0 flex-col gap-8">
        <Section
          title="결정할 일"
          aside={tasks.length > 0 ? `${tasks.reduce((a, t) => a + t.count, 0)}건` : undefined}
        >
          <TaskList tasks={tasks} />
        </Section>
        {deadlines !== undefined && (
          <Section title="다가오는 마감" aside="7일 안, 체험단">
            {deadlines}
          </Section>
        )}
      </div>
      <Section title="편성표" aside="한국 시간" className="lg:row-span-2">
        <ScheduleBoard scheduled={data.posts.scheduled} slots={slots} now={now} />
      </Section>
      <Section title="기록" className="lg:col-start-1">
        <RecordBand data={data} now={now} />
      </Section>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem]"
      role="status"
      aria-label="불러오는 중"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  )
}

const dateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: TZ,
  month: 'long',
  day: 'numeric',
  weekday: 'long',
})

/** The current time, moved on every 30 s: polling alone does not re-render unchanged data. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function OverviewPage() {
  const now = useNow()
  const q = useOverview()
  const campaigns = useCampaigns('active', null)
  const videos = useVideos('active')
  const ops = useOps()
  // Slots are wall-clock times in the worker's zone; the board shows KST, so they are used only
  // when the two agree (otherwise the board lists the scheduled posts alone).
  const settings = ops.data?.settings
  const slots = settings?.timeZone === TZ ? settings.publishSlots : null
  const videoRows = videos.data?.rows
  const videosWaiting = Array.isArray(videoRows)
    ? videoRows.filter((v) => v.status === 'PENDING_REVIEW').length
    : 0
  return (
    <>
      <PageHeader title="현황" description={dateFormat.format(now)} />
      <QueryBoundary query={q} skeleton={<OverviewSkeleton />}>
        {(data) => (
          <OverviewView
            data={data}
            now={now}
            slots={Array.isArray(slots) ? slots : null}
            videosWaiting={videosWaiting}
            deadlines={
              <QueryBoundary
                query={campaigns}
                skeleton={<Skeleton className="h-36 rounded-xl" role="status" aria-label="불러오는 중" />}
              >
                {(d) => <DeadlineList rows={Array.isArray(d.rows) ? d.rows : []} now={now} />}
              </QueryBoundary>
            }
          />
        )}
      </QueryBoundary>
    </>
  )
}
