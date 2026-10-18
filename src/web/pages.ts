import { daysUntil, formatDday, formatWon, statusLabel } from '../campaigns/telegram.ts'
import { CAMPAIGN_STATUSES, type CampaignStatus } from '../campaigns/types.ts'
import type {
  CampaignDetailData,
  CampaignFilter,
  CampaignListRow,
  OverviewData,
  PostRow,
} from './data.ts'

import { esc, extLink, formatAge, formatDateTime, layout, truncate } from './html.ts'

export type RenderCtx = { now: Date; tz: string }

/** A heartbeat older than this means the local worker (Kakao + Aside) is probably down. */
export const HEARTBEAT_STALE_MINUTES = 30

const dday = (d: Date | null, ctx: RenderCtx) =>
  d ? ` <span class="badge">${esc(formatDday(daysUntil(d, ctx.now, ctx.tz)))}</span>` : ''

const dateWithDday = (d: Date | null, ctx: RenderCtx) =>
  d ? `${esc(formatDateTime(d, ctx.tz))}${dday(d, ctx)}` : '-'

const stat = (label: string, n: number, href: string, warn = false) =>
  `<a class="stat" href="${esc(href)}"><b${warn && n > 0 ? ' style="color:var(--warn)"' : ''}>${n}</b><span>${esc(label)}</span></a>`

type Bucket = { label: string; statuses: CampaignStatus[]; warn?: boolean }
const BUCKETS: Bucket[] = [
  { label: '검수 대기', statuses: ['PENDING_REVIEW'] },
  { label: '신청 대기/진행', statuses: ['APPROVED', 'APPLYING'] },
  { label: '신청 실패', statuses: ['APPLY_FAILED'], warn: true },
  { label: '신청 완료', statuses: ['APPLIED'] },
  { label: '선정', statuses: ['SELECTED'] },
  {
    label: '리뷰 진행',
    statuses: ['RECEIVED', 'DRAFT_REVIEW', 'DRAFT_APPROVED', 'DRAFT_SAVING', 'DRAFT_SAVED'],
  },
  { label: '저장 실패', statuses: ['DRAFT_FAILED'], warn: true },
  { label: '게시 완료', statuses: ['POSTED'] },
]

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
  const campaigns = BUCKETS.map((b) =>
    stat(
      b.label,
      b.statuses.reduce((sum, s) => sum + (data.campaignCounts[s] ?? 0), 0),
      b.statuses.length === 1 ? `/campaigns?status=${b.statuses[0]}` : '/campaigns',
      b.warn,
    ),
  ).join('')
  const heartbeats =
    data.heartbeats.length === 0
      ? '<div class="empty">로컬 워커의 하트비트가 아직 없어요.</div>'
      : data.heartbeats
          .map((h) => {
            const ageMin = (ctx.now.getTime() - h.seen_at.getTime()) / 60_000
            const stale = ageMin > HEARTBEAT_STALE_MINUTES
            return `<div class="box"><b>${esc(h.role)}</b> 마지막 신호 ${esc(formatDateTime(h.seen_at, ctx.tz))} (${esc(formatAge(h.seen_at, ctx.now))}) <span class="badge ${stale ? 'warn' : 'ok'}">${stale ? '응답 없음' : '정상'}</span></div>`
          })
          .join('')
  const body = `<h1>현황</h1>
<h2>Threads</h2><div class="cards">${threads}</div>
<h2>발행 예정</h2>${scheduled}
<h2>체험단</h2><div class="cards">${campaigns}</div>
<p><a href="/campaigns">체험단 목록</a> · <a href="/posts">Threads 글 목록</a></p>
<h2>로컬 워커</h2>${heartbeats}
<p class="empty">${esc(formatDateTime(ctx.now, ctx.tz))} 기준 · 60초마다 새로고침</p>`
  return layout(body, { title: '현황', refresh: true })
}

const FILTER_CHIPS: { value: CampaignFilter; label: string }[] = [
  { value: 'active', label: '진행 중' },
  { value: 'all', label: '전체' },
  ...CAMPAIGN_STATUSES.filter((s) =>
    [
      'PENDING_REVIEW',
      'APPLY_FAILED',
      'APPLIED',
      'SELECTED',
      'DRAFT_SAVED',
      'DRAFT_FAILED',
      'POSTED',
      'REJECTED',
      'EXPIRED',
    ].includes(s),
  ).map((s) => ({ value: s as CampaignFilter, label: statusLabel(s) })),
]

export function renderCampaignList(
  rows: CampaignListRow[],
  filter: CampaignFilter,
  ctx: RenderCtx,
): string {
  const chips = FILTER_CHIPS.map(
    (c) =>
      `<a href="/campaigns?status=${esc(c.value)}"${c.value === filter ? ' class="on"' : ''}>${esc(c.label)}</a>`,
  ).join('')
  let table: string
  if (rows.length === 0) {
    table = '<div class="empty">해당하는 체험단이 없어요.</div>'
  } else {
    const trs = rows
      .map((c) => {
        return `<tr>
<td data-label="제목"><a href="/campaigns/${c.id}">#${c.id} ${esc(c.title ?? '(제목 없음)')}</a></td>
<td data-label="상태"><span class="badge">${esc(statusLabel(c.status))}</span></td>
<td data-label="제공">${c.reward_won != null ? esc(formatWon(c.reward_won)) : '-'}${c.offer ? ` ${esc(truncate(c.offer, 40))}` : ''}</td>
<td data-label="신청 마감">${dateWithDday(c.apply_deadline, ctx)}</td>
<td data-label="리뷰 마감">${dateWithDday(c.review_deadline, ctx)}</td>
<td data-label="점수">${c.score != null ? esc(c.score) : '-'}</td>
<td data-label="출처">${esc(c.found_in ?? '-')}</td>
<td data-label="갱신">${esc(formatDateTime(c.updated_at, ctx.tz))}</td></tr>`
      })
      .join('')
    table = `<div class="scroll"><table class="cards-m"><thead><tr><th>제목</th><th>상태</th><th>제공</th><th>신청 마감</th><th>리뷰 마감</th><th>점수</th><th>출처</th><th>갱신</th></tr></thead><tbody>${trs}</tbody></table></div>`
  }
  return layout(
    `<h1>체험단 <small class="badge">${rows.length}</small></h1><div class="chips">${chips}</div>${table}`,
    { title: '체험단', refresh: true },
  )
}

function field(label: string, valueHtml: string): string {
  return `<dt>${esc(label)}</dt><dd>${valueHtml}</dd>`
}

const text = (v: string | null | undefined) => (v ? esc(v) : '-')

export function renderCampaignDetail(data: CampaignDetailData, ctx: RenderCtx): string {
  const { campaign: c, reminders, photoCount } = data
  const d = c.detail
  const t = (x: Date | null) => esc(formatDateTime(x, ctx.tz))
  const parsed = [
    field('유형', text(c.type)),
    field('카테고리', text(c.category)),
    field('제공 내역', text(d?.offer)),
    field('제공 가치', c.reward_won != null ? esc(formatWon(c.reward_won)) : '-'),
    field('모집 인원', c.recruit_count != null ? esc(c.recruit_count) : '-'),
    field('키워드', c.keywords.length ? esc(c.keywords.join(', ')) : '-'),
    field('채널', text(d?.channel)),
    field('가이드', d?.guide ? `<pre>${esc(d.guide)}</pre>` : '-'),
    field('신청 마감', dateWithDday(c.apply_deadline, ctx)),
    field('발표', dateWithDday(c.announce_at, ctx)),
    field('리뷰 마감', dateWithDday(c.review_deadline, ctx)),
  ].join('')
  const ranking = [
    field('점수', c.score != null ? esc(c.score) : '-'),
    field('평가 이유', text(c.reason)),
    field('제외 사유', text(c.skip_reason)),
    field('신청 메시지', c.apply_message ? `<pre>${esc(c.apply_message)}</pre>` : '-'),
    field('거절 사유', text(c.reject_reason)),
    field('출처', text(c.found_in)),
  ].join('')
  const progress = [
    field('시도 횟수', esc(c.attempts)),
    field('마지막 오류', c.last_error ? `<pre>${esc(c.last_error)}</pre>` : '-'),
    field('신청', t(c.applied_at)),
    field('선정', t(c.selected_at)),
    field('제품 수령', t(c.received_at)),
    field('임시저장', t(c.draft_saved_at)),
    field('게시', t(c.posted_at)),
    field(
      '알림 발송',
      reminders.length
        ? esc(reminders.map((r) => `${r.kind} (${formatDateTime(r.sent_at, ctx.tz)})`).join(', '))
        : '-',
    ),
    field('사진', `${photoCount}장`),
    field('생성', t(c.created_at)),
    field('갱신', t(c.updated_at)),
  ].join('')
  const draft = c.draft_title || c.draft_body
  const body = `<p><a href="/campaigns">← 목록</a></p>
<h1>#${c.id} ${esc(c.title ?? '(제목 없음)')} <span class="badge">${esc(statusLabel(c.status))}</span></h1>
<div class="box"><dl>${field('revu', extLink(c.url))}${field('블로그', extLink(c.blog_url))}</dl></div>
<h2>공고</h2><div class="box"><dl>${parsed}</dl></div>
<h2>평가·신청</h2><div class="box"><dl>${ranking}</dl></div>
<h2>진행 상태</h2><div class="box"><dl>${progress}</dl></div>
<h2>블로그 초안</h2><div class="box">${
    draft
      ? `<b>${esc(c.draft_title ?? '')}</b><pre>${esc(c.draft_body ?? '')}</pre>${c.memo ? `<h2>메모</h2><pre>${esc(c.memo)}</pre>` : ''}`
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
