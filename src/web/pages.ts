import { daysUntil, formatDday, formatWon } from '../campaigns/telegram.ts'
import {
  CAMPAIGN_SOURCE_KEYS,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignSource,
  type CampaignStatus,
  campaignPriceInfo,
  competition,
  musinsaCategoryLabel,
  musinsaFacts,
  sourceInfo,
} from '../campaigns/types.ts'
import {
  type CampaignDetailData,
  type CampaignFilter,
  type CampaignListRow,
  type NextDeadline,
  nextDeadline,
  type OverviewData,
  type PostRow,
} from './data.ts'
import {
  esc,
  extLink,
  formatAge,
  formatDateTime,
  isAllowedImageUrl,
  layout,
  truncate,
} from './html.ts'

export type RenderCtx = { now: Date; tz: string }

const STATUS_LABELS: Record<CampaignStatus, string> = {
  COLLECTED: '수집됨',
  SKIPPED: '제외',
  SHORTLISTED: '후보',
  PENDING_REVIEW: '검수 대기',
  REJECTED: '패스',
  EXPIRED: '만료',
  APPLIED: '신청함',
  SELECTED: '선정',
  NOT_SELECTED: '탈락',
  DRAFT_REVIEW: '리뷰 초안',
  POSTED: '리뷰 완료',
}

export const sourceLabel = (source: string) => sourceInfo(source).label

export const statusLabel = (status: string) => STATUS_LABELS[status as CampaignStatus] ?? status

/** `1,234:1` applicants per slot (one decimal below 10:1), or `-` when unknown. */
export function formatCompetition(
  c: Pick<Campaign, 'application_count' | 'recruit_count'>,
): string {
  const ratio = competition(c)
  if (ratio == null) return '-'
  const shown = ratio >= 10 ? Math.round(ratio).toLocaleString('en-US') : ratio.toFixed(1)
  return `${shown}:1`
}

const dday = (d: Date | null, ctx: RenderCtx) =>
  d ? ` <span class="badge">${esc(formatDday(daysUntil(d, ctx.now, ctx.tz)))}</span>` : ''

const dateWithDday = (d: Date | null, ctx: RenderCtx) =>
  d ? `${esc(formatDateTime(d, ctx.tz))}${dday(d, ctx)}` : '-'

const stat = (label: string, n: number, href: string, warn = false) =>
  `<a class="stat" href="${esc(href)}"><b${warn && n > 0 ? ' style="color:var(--warn)"' : ''}>${n}</b><span>${esc(label)}</span></a>`

export function renderOverview(data: OverviewData, ctx: RenderCtx): string {
  const p = data.posts
  const threads = [
    stat('검수 대기', p.pendingReview, '/posts'),
    stat('발행 예정', p.scheduled.length, '/posts'),
    stat('최근 24h 발행', p.published24h, '/posts'),
    stat('실패', p.failed, '/posts', true),
  ].join('')
  const scheduled =
    p.scheduled.length === 0
      ? '<div class="empty">발행 예정인 글이 없어요.</div>'
      : p.scheduled
          .map(
            (s) =>
              `<div class="box"><b>${esc(formatDateTime(s.scheduled_at, ctx.tz))}</b> ${esc(truncate(s.text, 60))}</div>`,
          )
          .join('')
  const c = data.campaigns
  const n = (s: CampaignStatus) => c.counts[s] ?? 0
  const campaigns = [
    stat('검수 대기', n('PENDING_REVIEW'), '/campaigns?status=PENDING_REVIEW'),
    stat('신청함·결과 대기', n('APPLIED'), '/campaigns?status=APPLIED'),
    stat('선정·리뷰 전', n('SELECTED'), '/campaigns?status=SELECTED'),
    stat('리뷰 초안', n('DRAFT_REVIEW'), '/campaigns?status=DRAFT_REVIEW'),
    stat('최근 30일 리뷰 완료', c.postedLast30d, '/campaigns?status=POSTED'),
  ].join('')
  const bySource = CAMPAIGN_SOURCE_KEYS.map((src) => {
    const m = c.bySource?.[src] ?? {}
    const total = Object.values(m).reduce((a, b) => a + (b ?? 0), 0)
    const active =
      (m.PENDING_REVIEW ?? 0) + (m.APPLIED ?? 0) + (m.SELECTED ?? 0) + (m.DRAFT_REVIEW ?? 0)
    return `<a class="stat" href="/campaigns?source=${esc(src)}"><b>${active}</b><span>${esc(sourceLabel(src))} 진행 중 (전체 ${total})</span></a>`
  }).join('')
  const collection = c.lastCollectedAt
    ? `<div class="box">마지막 수집 <b>${esc(formatDateTime(c.lastCollectedAt, ctx.tz))}</b> (${esc(formatAge(c.lastCollectedAt, ctx.now))}) · 그때 확인한 체험단 ${c.lastSeenCount}건</div>`
    : '<div class="empty">아직 수집한 체험단이 없어요.</div>'
  const body = `<h1>현황</h1>
<h2>Threads</h2><div class="cards">${threads}</div>
<h2>발행 예정</h2>${scheduled}
<h2>체험단</h2><div class="cards">${campaigns}</div>
<h2>출처별</h2><div class="cards">${bySource}</div>${collection}
<p><a href="/campaigns">체험단 목록</a> · <a href="/posts">Threads 글 목록</a></p>
<p class="empty">${esc(formatDateTime(ctx.now, ctx.tz))} 기준 · 60초마다 새로고침</p>`
  return layout(body, { title: '현황', refresh: true })
}

const CHIP_STATUSES: CampaignStatus[] = [
  'PENDING_REVIEW',
  'APPLIED',
  'SELECTED',
  'DRAFT_REVIEW',
  'POSTED',
  'NOT_SELECTED',
  'REJECTED',
  'EXPIRED',
  'SKIPPED',
  'SHORTLISTED',
  'COLLECTED',
]

const FILTER_CHIPS: { value: CampaignFilter; label: string }[] = [
  { value: 'active', label: '진행 중' },
  { value: 'all', label: '전체' },
  ...CAMPAIGN_STATUSES.filter((s) => CHIP_STATUSES.includes(s))
    .sort((a, b) => CHIP_STATUSES.indexOf(a) - CHIP_STATUSES.indexOf(b))
    .map((s) => ({ value: s as CampaignFilter, label: statusLabel(s) })),
]

/** `D-3` badge for the stage's deadline; estimated apply deadlines carry a marker. */
function deadlineCell(d: NextDeadline | null, ctx: RenderCtx, source: string): string {
  if (!d) return '-'
  const label = formatDday(daysUntil(d.at, ctx.now, ctx.tz))
  return `<span class="badge">${esc(label)}</span>${d.kind === 'apply' && sourceInfo(source).estimatedDeadline ? ' <small class="muted">추정</small>' : ''}`
}

const sourceQuery = (source: CampaignSource | null) => (source ? `&source=${esc(source)}` : '')

export function renderCampaignList(
  rows: CampaignListRow[],
  filter: CampaignFilter,
  ctx: RenderCtx,
  source: CampaignSource | null = null,
): string {
  const chips = FILTER_CHIPS.map(
    (c) =>
      `<a href="/campaigns?status=${esc(c.value)}${sourceQuery(source)}"${c.value === filter ? ' class="on"' : ''}>${esc(c.label)}</a>`,
  ).join('')
  const sourceChips = [
    { value: null, label: '모든 출처' },
    ...CAMPAIGN_SOURCE_KEYS.map((s) => ({ value: s, label: sourceLabel(s) })),
  ]
    .map(
      (c) =>
        `<a href="/campaigns?status=${esc(filter)}${sourceQuery(c.value)}"${c.value === source ? ' class="on"' : ''}>${esc(c.label)}</a>`,
    )
    .join('')
  let table: string
  if (rows.length === 0) {
    table = '<div class="empty">해당하는 체험단이 없어요.</div>'
  } else {
    const trs = rows
      .map(
        (c) => `<tr>
<td data-label="출처">${esc(sourceLabel(c.source))}</td>
<td data-label="제목"><a href="/campaigns/${c.id}">#${c.id} ${esc(c.title || '(제목 없음)')}</a></td>
<td data-label="브랜드">${esc(c.brand ?? '-')}</td>
<td data-label="상태"><span class="badge">${esc(statusLabel(c.status))}</span></td>
<td data-label="경쟁률">${esc(formatCompetition(c))}</td>
<td data-label="마감">${deadlineCell(nextDeadline(c), ctx, c.source)}</td>
<td data-label="점수">${c.score != null ? esc(c.score) : '-'}</td></tr>`,
      )
      .join('')
    table = `<div class="scroll"><table class="cards-m"><thead><tr><th>출처</th><th>제목</th><th>브랜드</th><th>상태</th><th>경쟁률</th><th>마감</th><th>점수</th></tr></thead><tbody>${trs}</tbody></table></div>`
  }
  return layout(
    `<h1>체험단 <small class="badge">${rows.length}</small></h1><div class="chips">${sourceChips}</div><div class="chips">${chips}</div>${table}`,
    { title: '체험단', refresh: true },
  )
}

function field(label: string, valueHtml: string): string {
  return `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>`
}

const text = (v: string | null | undefined) => (v ? esc(v) : '-')
const count = (v: number | null) => (v != null ? esc(v.toLocaleString('en-US')) : '-')

export function renderCampaignDetail(data: CampaignDetailData, ctx: RenderCtx): string {
  const { campaign: c, reminders } = data
  const t = (x: Date | null) => esc(formatDateTime(x, ctx.tz))
  const thumb = isAllowedImageUrl(c.image_url)
    ? `<p><img src="${esc(c.image_url)}" alt="" width="160" referrerpolicy="no-referrer" loading="lazy" style="max-width:160px;border-radius:8px"></p>`
    : ''
  const m = musinsaFacts(c)
  const sourceFields = m
    ? [
        field('품목', m.category ? esc(musinsaCategoryLabel(m.category)) : '-'),
        field(
          '정가',
          m.price != null
            ? `${esc(formatWon(m.price))}${m.salePrice != null ? ` → ${esc(formatWon(m.salePrice))}` : ''}`
            : '-',
        ),
        field('상품 수', m.goodsCount != null ? esc(m.goodsCount) : '-'),
        field('발표일', text(m.winnerDrawDate)),
        field(
          '리뷰 기간',
          m.reviewStartDate || m.reviewEndDate
            ? `${esc(m.reviewStartDate ?? '?')} ~ ${esc(m.reviewEndDate ?? '?')}`
            : '-',
        ),
      ]
    : c.source === 'kakao-gift'
      ? [
          field(
            '정가',
            (() => {
              const p = campaignPriceInfo(c)
              if (p.price == null) return '-'
              return `${esc(formatWon(p.price))}${p.salePrice != null ? ` → ${esc(formatWon(p.salePrice))}` : ''}`
            })(),
          ),
        ]
      : []
  const listing = [
    field('출처', esc(sourceLabel(c.source))),
    field('브랜드', text(c.brand)),
    ...sourceFields,
    field('상품 ID', c.product_id != null ? esc(c.product_id) : '-'),
    field('모집 인원', count(c.recruit_count)),
    field('신청자', count(c.application_count)),
    field('경쟁률', esc(formatCompetition(c))),
    field('남은 일수', c.remaining_days != null ? `${esc(c.remaining_days)}일` : '-'),
    field(
      sourceInfo(c.source).estimatedDeadline ? '신청 마감 (추정)' : '신청 마감',
      dateWithDday(c.apply_deadline, ctx),
    ),
    field('처음 본 시각', t(c.first_seen_at)),
    field('마지막으로 본 시각', t(c.last_seen_at)),
  ].join('')
  const ranking = [
    field('점수', c.score != null ? esc(c.score) : '-'),
    field('평가 이유', text(c.reason)),
    field('제외 사유', text(c.skip_reason)),
    field('패스 사유', text(c.reject_reason)),
  ].join('')
  const progress = [
    field('신청', t(c.applied_at)),
    field('선정', t(c.selected_at)),
    field('결과 확인', t(c.result_at)),
    field('리뷰 마감', dateWithDday(c.review_deadline, ctx)),
    field('리뷰 완료', t(c.posted_at)),
    field(
      '알림 발송',
      reminders.length
        ? esc(reminders.map((r) => `${r.kind} (${formatDateTime(r.sent_at, ctx.tz)})`).join(', '))
        : '-',
    ),
    field('생성', t(c.created_at)),
    field('갱신', t(c.updated_at)),
  ].join('')
  const body = `<p><a href="/campaigns">← 목록</a></p>
<h1>#${c.id} ${esc(c.title || '(제목 없음)')} <span class="badge">${esc(statusLabel(c.status))}</span></h1>
${thumb}<div class="box"><dl>${field('링크', extLink(c.url, `${sourceLabel(c.source)}에서 열기`))}</dl></div>
<h2>공고</h2><div class="box"><dl>${listing}</dl></div>
<h2>평가</h2><div class="box"><dl>${ranking}</dl></div>
<h2>진행 상태</h2><div class="box"><dl>${progress}</dl></div>
<h2>메모</h2><div class="box">${c.memo ? `<pre>${esc(c.memo)}</pre>` : '<div class="empty">메모가 없어요.</div>'}</div>
<h2>리뷰 초안</h2><div class="box">${
    c.draft_text
      ? `<pre>${esc(c.draft_text)}</pre>`
      : '<div class="empty">아직 초안이 없어요.</div>'
  }</div>`
  return layout(body, { title: `체험단 #${c.id}` })
}

const POST_STATUS: Record<string, string> = {
  PENDING_REVIEW: '검수 대기',
  APPROVED: '승인',
  SCHEDULED: '발행 예정',
  PUBLISHING: '발행 중',
  PUBLISHED: '발행됨',
  FAILED: '실패',
  REJECTED: '거절',
  EXPIRED: '만료',
}

const num = (n: number | null) => (n == null ? '-' : String(n))

export function renderPosts(rows: PostRow[], ctx: RenderCtx): string {
  let table: string
  if (rows.length === 0) {
    table = '<div class="empty">글이 아직 없어요.</div>'
  } else {
    const trs = rows
      .map((p) => {
        const hasInsights = p.views != null || p.likes != null || p.replies != null
        return `<tr>
<td data-label="상태"><span class="badge${p.status === 'FAILED' ? ' warn' : ''}">${esc(POST_STATUS[p.status] ?? p.status)}</span></td>
<td data-label="예약">${esc(formatDateTime(p.scheduled_at, ctx.tz))}</td>
<td data-label="발행">${esc(formatDateTime(p.published_at, ctx.tz))}</td>
<td data-label="내용">${esc(truncate(p.text, 80))}</td>
<td data-label="반응">${hasInsights ? `조회 ${num(p.views)} · 좋아요 ${num(p.likes)} · 답글 ${num(p.replies)}` : '-'}</td></tr>`
      })
      .join('')
    table = `<div class="scroll"><table class="cards-m"><thead><tr><th>상태</th><th>예약</th><th>발행</th><th>내용</th><th>반응</th></tr></thead><tbody>${trs}</tbody></table></div>`
  }
  return layout(`<h1>최근 Threads 글</h1>${table}`, { title: 'Threads 글', refresh: true })
}

export function renderNotFound(): string {
  return layout('<h1>찾을 수 없어요</h1><p><a href="/">현황으로</a></p>', { title: '404' })
}

export function renderError(): string {
  return layout('<h1>일시적인 오류</h1><p>잠시 후 다시 시도해 주세요.</p>', { title: '오류' })
}
