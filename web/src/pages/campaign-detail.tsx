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
              <Field label="정가">{m.price != null ? formatWon(m.price) : '-'}</Field>
              <Field label="상품 수">{m.goodsCount ?? '-'}</Field>
              <Field label="리뷰 형식">
                {m.contentType === 'VIDEO' ? '영상' : m.contentType === 'IMAGE' ? '사진' : '-'}
              </Field>
            </>
          )}
          <Field label="상품 ID">{c.product_id ?? '-'}</Field>
          {!m && (
            <>
              <Field label="모집 인원">{formatNumber(c.recruit_count)}</Field>
              <Field label="신청자">{formatNumber(c.application_count)}</Field>
              <Field label="경쟁률">{formatCompetition(competitionOf(c))}</Field>
            </>
          )}
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
