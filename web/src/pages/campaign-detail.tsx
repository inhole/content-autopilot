import { ArrowLeftIcon, ExternalLinkIcon, GiftIcon } from 'lucide-react'
import { Children, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import { CampaignStatusBadge, SourceLabel } from '@/components/status-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import {
  competitionOf,
  daysUntil,
  formatCompetition,
  formatDateTime,
  formatDday,
  formatNumber,
  formatWon,
  hasEstimatedDeadline,
  isAllowedImageUrl,
  isHttpUrl,
  sourceLabel,
  sourceLinkLabel,
} from '@/lib/format.ts'
import { useCampaign } from '@/lib/queries.ts'
import { deadlineTone } from '@/lib/status.ts'
import type { CampaignDetailResponse } from '@/lib/types.ts'

type Campaign = CampaignDetailResponse['campaign']

/** Musinsa-only facts out of `campaigns.detail`; null for other sources. */
export function musinsaFacts(c: Pick<Campaign, 'source' | 'detail'>) {
  if (c.source !== 'musinsa') return null
  const d = (c.detail ?? {}) as {
    representativeGoods?: { price?: unknown } | null
    goodsCount?: unknown
    contentType?: unknown
  }
  const price = d.representativeGoods?.price
  return {
    price: typeof price === 'number' ? price : null,
    goodsCount: typeof d.goodsCount === 'number' ? d.goodsCount : null,
    contentType: d.contentType === 'VIDEO' || d.contentType === 'IMAGE' ? d.contentType : null,
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** A definition list whose rows are divided by Separators. */
function FieldList({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean)
  return (
    <dl className="flex flex-col">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static rows
        <div key={i}>
          {i > 0 && <Separator />}
          {row}
        </div>
      ))}
    </dl>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  )
}

const dateWithDday = (iso: string | null, now?: Date) => {
  if (!iso) return '-'
  const days = daysUntil(iso, now)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular-nums">{formatDateTime(iso)}</span>
      <Badge variant={deadlineTone(days)} className="tabular-nums">
        {formatDday(days)}
      </Badge>
    </span>
  )
}

const text = (v: string | null | undefined) => v || '-'
const when = (iso: string | null) => <span className="tabular-nums">{formatDateTime(iso)}</span>

const titleOf = (c: Pick<Campaign, 'id' | 'title'>) => `#${c.id} ${c.title || '(제목 없음)'}`

export function CampaignDetailView({
  data,
  now,
  heading = true,
}: {
  data: CampaignDetailResponse
  now?: Date
  /** false when the surrounding sheet already shows the title. */
  heading?: boolean
}) {
  const { campaign: c, reminders } = data
  const m = musinsaFacts(c)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        {isAllowedImageUrl(c.image_url) && (
          <img
            src={c.image_url}
            alt=""
            width={96}
            height={96}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="size-24 shrink-0 rounded-lg border object-cover"
          />
        )}
        <div className="flex min-w-0 flex-col items-start gap-2">
          {heading && (
            <h1 className="text-xl font-semibold tracking-tight break-words">{titleOf(c)}</h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <CampaignStatusBadge status={c.status} />
            <SourceLabel source={c.source} />
          </div>
          {isHttpUrl(c.url) ? (
            <Button asChild size="sm" variant="outline">
              <a href={c.url} target="_blank" rel="noreferrer noopener">
                {sourceLinkLabel(c.source)}
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">링크 없음</span>
          )}
        </div>
      </div>

      <Section title="공고">
        <FieldList>
          <Field label="출처">{sourceLabel(c.source)}</Field>
          <Field label="브랜드">{text(c.brand)}</Field>
          {m && (
            <Field label="정가">
              <span className="tabular-nums">{m.price != null ? formatWon(m.price) : '-'}</span>
            </Field>
          )}
          {m && <Field label="상품 수">{m.goodsCount ?? '-'}</Field>}
          {m && (
            <Field label="리뷰 형식">
              {m.contentType === 'VIDEO' ? '영상' : m.contentType === 'IMAGE' ? '사진' : '-'}
            </Field>
          )}
          <Field label="상품 ID">{c.product_id ?? '-'}</Field>
          {!m && (
            <Field label="모집 인원">
              <span className="tabular-nums">{formatNumber(c.recruit_count)}</span>
            </Field>
          )}
          {!m && (
            <Field label="신청자">
              <span className="tabular-nums">{formatNumber(c.application_count)}</span>
            </Field>
          )}
          {!m && (
            <Field label="경쟁률">
              <span className="tabular-nums">{formatCompetition(competitionOf(c))}</span>
            </Field>
          )}
          <Field label="남은 일수">
            {c.remaining_days != null ? `${c.remaining_days}일` : '-'}
          </Field>
          <Field label={hasEstimatedDeadline(c.source) ? '신청 마감 (추정)' : '신청 마감'}>
            {dateWithDday(c.apply_deadline, now)}
          </Field>
          <Field label="처음 본 시각">{when(c.first_seen_at)}</Field>
          <Field label="마지막으로 본 시각">{when(c.last_seen_at)}</Field>
        </FieldList>
      </Section>

      <Section title="선별" description="점수와 제외·패스 사유">
        <FieldList>
          <Field label="점수">
            <span className="tabular-nums">{c.score ?? '-'}</span>
          </Field>
          <Field label="평가 이유">{text(c.reason)}</Field>
          <Field label="제외 사유">{text(c.skip_reason)}</Field>
          <Field label="패스 사유">{text(c.reject_reason)}</Field>
        </FieldList>
      </Section>

      <Section title="진행" description="신청부터 리뷰 완료까지">
        <FieldList>
          <Field label="신청">{when(c.applied_at)}</Field>
          <Field label="선정">{when(c.selected_at)}</Field>
          <Field label="결과 확인">{when(c.result_at)}</Field>
          <Field label="리뷰 마감">{dateWithDday(c.review_deadline, now)}</Field>
          <Field label="리뷰 완료">{when(c.posted_at)}</Field>
          <Field label="알림 발송">
            {reminders.length
              ? reminders.map((r) => `${r.kind} (${formatDateTime(r.sent_at)})`).join(', ')
              : '-'}
          </Field>
          <Field label="생성">{when(c.created_at)}</Field>
          <Field label="갱신">{when(c.updated_at)}</Field>
        </FieldList>
      </Section>

      <Section title="메모·초안">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">메모</span>
            {c.memo ? (
              <pre className="font-[inherit] break-words whitespace-pre-wrap">{c.memo}</pre>
            ) : (
              <p className="text-muted-foreground">메모가 없어요.</p>
            )}
          </div>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">리뷰 초안</span>
            {c.draft_text ? (
              <pre className="font-[inherit] break-words whitespace-pre-wrap">{c.draft_text}</pre>
            ) : (
              <p className="text-muted-foreground">아직 초안이 없어요.</p>
            )}
          </div>
        </div>
      </Section>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="불러오는 중">
      <div className="flex gap-4">
        <Skeleton className="size-24 rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
    </div>
  )
}

const parseId = (raw: string | undefined) => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Direct navigation to /campaigns/:id: a full page. */
export function CampaignDetailPage() {
  const id = parseId(useParams().id)
  const q = useCampaign(id ?? 0)
  const { search } = useLocation()
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to={{ pathname: '/campaigns', search }}>
          <ArrowLeftIcon data-icon="inline-start" />
          목록
        </Link>
      </Button>
      {id ? (
        <QueryBoundary query={q} skeleton={<DetailSkeleton />}>
          {(data) => <CampaignDetailView data={data} />}
        </QueryBoundary>
      ) : (
        <EmptyState title="잘못된 주소예요." icon={GiftIcon} />
      )}
    </>
  )
}

/** The same detail as a sheet over the list (opened from a row, history keeps the list behind). */
export function CampaignSheet() {
  const id = parseId(useParams().id)
  const q = useCampaign(id ?? 0)
  const navigate = useNavigate()
  const title = q.data ? titleOf(q.data.campaign) : '체험단 상세'
  return (
    <Sheet open onOpenChange={(open) => !open && navigate(-1)}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8 leading-snug break-words">{title}</SheetTitle>
          <SheetDescription>체험단 상세</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {id ? (
            <QueryBoundary query={q} skeleton={<DetailSkeleton />}>
              {(data) => <CampaignDetailView data={data} heading={false} />}
            </QueryBoundary>
          ) : (
            <EmptyState title="잘못된 주소예요." icon={GiftIcon} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

