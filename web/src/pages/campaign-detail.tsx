import { ArrowLeftIcon, ExternalLinkIcon, GiftIcon } from 'lucide-react'
import { Children, type ReactNode, useState } from 'react'
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
import { CopyButton } from '@/components/copy-button.tsx'
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
import { CampaignActionsPanel } from '@/pages/campaign-actions.tsx'
import { useCampaign } from '@/lib/queries.ts'
import { deadlineTone } from '@/lib/status.ts'
import type { CampaignDetailResponse } from '@/lib/types.ts'

type Campaign = CampaignDetailResponse['campaign']

const MUSINSA_CATEGORY_LABELS: Record<string, string> = {
  BEAUTY: '뷰티',
  SHOE: '신발',
  TOP: '상의',
  OUTER: '아우터',
  PANTS: '바지',
  DRESS_AND_SKIRT: '원피스/스커트',
  BAG: '가방',
  FASHION_ACCESSORY: '패션 소품',
  UNDERWEAR: '속옷/홈웨어',
  SPORTS: '스포츠/레저',
  DIGITAL_LIFE: '디지털/라이프',
  KIDS: '키즈',
}

const asString = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** Kakao gift price out of `campaigns.detail.price` (same reading as campaignPriceInfo in src/campaigns/types.ts). */
export function giftPrice(c: Pick<Campaign, 'source' | 'detail'>) {
  const raw = (c.detail as { price?: { basic?: unknown; selling?: unknown } | null } | null)?.price
  const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : null)
  const selling = num(raw?.selling)
  const price = num(raw?.basic) ?? selling
  return {
    price,
    salePrice: selling !== null && price !== null && selling < price ? selling : null,
  }
}

/** Musinsa-only facts out of `campaigns.detail` (same reading as src/campaigns/types.ts). */
export function musinsaFacts(c: Pick<Campaign, 'source' | 'detail'>) {
  if (c.source !== 'musinsa') return null
  const d = (c.detail ?? {}) as {
    products?: {
      isRepresentative?: boolean | null
      prices?: { normalPrice?: { value?: unknown }; salePrice?: { value?: unknown } } | null
    }[]
    eventCategory?: unknown
    winnerDrawDate?: unknown
    reviewStartDate?: unknown
    reviewEndDate?: unknown
  }
  const products = Array.isArray(d.products) ? d.products : []
  const rep = products.find((p) => p?.isRepresentative) ?? products[0]
  const normal = rep?.prices?.normalPrice?.value
  const sale = rep?.prices?.salePrice?.value
  const price = typeof normal === 'number' ? normal : null
  const category = asString(d.eventCategory)
  return {
    price,
    salePrice: typeof sale === 'number' && price !== null && sale < price ? sale : null,
    goodsCount: products.length || null,
    category: category ? (MUSINSA_CATEGORY_LABELS[category] ?? category) : null,
    winnerDrawDate: asString(d.winnerDrawDate),
    reviewStartDate: asString(d.reviewStartDate),
    reviewEndDate: asString(d.reviewEndDate),
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
  const gift = giftPrice(c)
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

      <CampaignActionsPanel data={data} now={now} />

      <Section title="공고">
        <FieldList>
          <Field label="출처">{sourceLabel(c.source)}</Field>
          <Field label="브랜드">{text(c.brand)}</Field>
          {m && (
            <>
              <Field label="품목">{m.category ?? '-'}</Field>
              <Field label="정가">
                <span className="tabular-nums">
                  {m.price != null ? formatWon(m.price) : '-'}
                  {m.price != null && m.salePrice != null && ` → ${formatWon(m.salePrice)}`}
                </span>
              </Field>
              <Field label="상품 수">{m.goodsCount ?? '-'}</Field>
              <Field label="발표일">{m.winnerDrawDate ?? '-'}</Field>
              <Field label="리뷰 기간">
                {m.reviewStartDate || m.reviewEndDate
                  ? `${m.reviewStartDate ?? '?'} ~ ${m.reviewEndDate ?? '?'}`
                  : '-'}
              </Field>
            </>
          )}
          {!m && (
            <Field label="정가">
              <span className="tabular-nums">
                {gift.price != null ? formatWon(gift.price) : '-'}
                {gift.price != null && gift.salePrice != null && ` → ${formatWon(gift.salePrice)}`}
              </span>
            </Field>
          )}
          <Field label="상품 ID">{c.product_id ?? '-'}</Field>
          <Field label="모집 인원">
            <span className="tabular-nums">{formatNumber(c.recruit_count)}</span>
          </Field>
          <Field label="신청자">
            <span className="tabular-nums">{formatNumber(c.application_count)}</span>
          </Field>
          <Field label="경쟁률">
            <span className="tabular-nums">{formatCompetition(competitionOf(c))}</span>
          </Field>
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
              <>
                <pre className="font-[inherit] break-words whitespace-pre-wrap">{c.draft_text}</pre>
                <div>
                  <CopyButton text={c.draft_text} label="초안 복사" />
                </div>
              </>
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
  // The sheet is a route without a Radix trigger, so Radix cannot give focus back on close.
  // Remember the link that opened it (still mounted in the list behind) and return focus there.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  return (
    <Sheet open onOpenChange={(open) => !open && navigate(-1)}>
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        onCloseAutoFocus={(e) => {
          if (opener?.isConnected) {
            e.preventDefault()
            opener.focus()
          }
        }}
      >
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

