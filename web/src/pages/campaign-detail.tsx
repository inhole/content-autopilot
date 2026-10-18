import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx'
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
  statusLabel,
} from '@/lib/format.ts'
import { useCampaign } from '@/lib/queries.ts'
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
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 border-b py-1.5 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const dateWithDday = (iso: string | null, now?: Date) =>
  iso ? (
    <>
      {formatDateTime(iso)} <Badge variant="outline">{formatDday(daysUntil(iso, now))}</Badge>
    </>
  ) : (
    '-'
  )

const text = (v: string | null | undefined) => v || '-'

export function CampaignDetailView({ data, now }: { data: CampaignDetailResponse; now?: Date }) {
  const { campaign: c, reminders } = data
  const m = musinsaFacts(c)
  return (
    <div className="space-y-4">
      <h1 className="flex flex-wrap items-start gap-2 text-lg font-semibold">
        <span className="break-words">
          #{c.id} {c.title || '(제목 없음)'}
        </span>
        <Badge>{statusLabel(c.status)}</Badge>
      </h1>

      {isAllowedImageUrl(c.image_url) && (
        <img
          src={c.image_url}
          alt=""
          width={160}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="max-w-40 rounded-lg border"
        />
      )}

      {isHttpUrl(c.url) ? (
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-sm font-medium text-primary hover:underline"
        >
          {sourceLinkLabel(c.source)}
        </a>
      ) : (
        <span className="text-sm text-muted-foreground">링크 없음</span>
      )}

      <Section title="공고">
        <dl>
          <Field label="출처">{sourceLabel(c.source)}</Field>
          <Field label="브랜드">{text(c.brand)}</Field>
          {m && (
            <>
              <Field label="품목">{m.category ?? '-'}</Field>
              <Field label="정가">
                {m.price != null ? formatWon(m.price) : '-'}
                {m.price != null && m.salePrice != null && ` → ${formatWon(m.salePrice)}`}
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
          <Field label="상품 ID">{c.product_id ?? '-'}</Field>
          <Field label="모집 인원">{formatNumber(c.recruit_count)}</Field>
          <Field label="신청자">{formatNumber(c.application_count)}</Field>
          <Field label="경쟁률">{formatCompetition(competitionOf(c))}</Field>
          <Field label="남은 일수">
            {c.remaining_days != null ? `${c.remaining_days}일` : '-'}
          </Field>
          <Field label={hasEstimatedDeadline(c.source) ? '신청 마감 (추정)' : '신청 마감'}>
            {dateWithDday(c.apply_deadline, now)}
          </Field>
          <Field label="처음 본 시각">{formatDateTime(c.first_seen_at)}</Field>
          <Field label="마지막으로 본 시각">{formatDateTime(c.last_seen_at)}</Field>
        </dl>
      </Section>

      <Section title="평가">
        <dl>
          <Field label="점수">{c.score ?? '-'}</Field>
          <Field label="평가 이유">{text(c.reason)}</Field>
          <Field label="제외 사유">{text(c.skip_reason)}</Field>
          <Field label="패스 사유">{text(c.reject_reason)}</Field>
        </dl>
      </Section>

      <Section title="진행 상태">
        <dl>
          <Field label="신청">{formatDateTime(c.applied_at)}</Field>
          <Field label="선정">{formatDateTime(c.selected_at)}</Field>
          <Field label="결과 확인">{formatDateTime(c.result_at)}</Field>
          <Field label="리뷰 마감">{dateWithDday(c.review_deadline, now)}</Field>
          <Field label="리뷰 완료">{formatDateTime(c.posted_at)}</Field>
          <Field label="알림 발송">
            {reminders.length
              ? reminders.map((r) => `${r.kind} (${formatDateTime(r.sent_at)})`).join(', ')
              : '-'}
          </Field>
          <Field label="생성">{formatDateTime(c.created_at)}</Field>
          <Field label="갱신">{formatDateTime(c.updated_at)}</Field>
        </dl>
      </Section>

      <Section title="메모">
        {c.memo ? (
          <pre className="whitespace-pre-wrap break-words font-[inherit] text-sm">{c.memo}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">메모가 없어요.</p>
        )}
      </Section>

      <Section title="리뷰 초안">
        {c.draft_text ? (
          <pre className="whitespace-pre-wrap break-words font-[inherit] text-sm">
            {c.draft_text}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">아직 초안이 없어요.</p>
        )}
      </Section>
    </div>
  )
}

export function CampaignDetailPage() {
  const { id } = useParams()
  const num = Number(id)
  const valid = Number.isInteger(num) && num > 0
  const q = useCampaign(valid ? num : 0)
  return (
    <>
      <Link to="/campaigns" className="text-sm text-primary hover:underline">
        ← 목록
      </Link>
      {valid ? (
        <QueryBoundary query={q}>{(data) => <CampaignDetailView data={data} />}</QueryBoundary>
      ) : (
        <EmptyState>잘못된 주소예요.</EmptyState>
      )}
    </>
  )
}
