export const TZ = 'Asia/Seoul'

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
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

export const SOURCES = [
  { key: 'kakao-gift', label: '카카오톡', linkLabel: '카카오톡에서 열기', estimatedDeadline: true },
  { key: 'musinsa', label: '무신사', linkLabel: '무신사에서 열기', estimatedDeadline: false },
] as const

export const POST_STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: '검수 대기',
  APPROVED: '승인',
  SCHEDULED: '발행 예정',
  PUBLISHING: '발행 중',
  PUBLISHED: '발행됨',
  FAILED: '실패',
  REJECTED: '거절',
  EXPIRED: '만료',
}

export const ORIGIN_LABELS: Record<string, string> = {
  revived: '♻️ 재활용',
  digest: '🗞 주간 묶음',
}

/** Labels of the 🗑 폐기 reasons (REJECT_REASONS in src/pipeline/style.ts). */
export const POST_REJECT_LABELS: Record<string, string> = {
  fact: '사실 오류',
  boring: '재미없음',
  topic: '주제 별로',
  dup: '중복',
  other: '기타',
}

export const PART_STATUS_LABELS: Record<string, string> = {
  PENDING: '대기',
  PUBLISHING: '발행 중',
  PUBLISHED: '발행됨',
  FAILED: '실패',
}

export const VERDICT_LABELS: Record<string, string> = {
  evergreen: '상록',
  stale: '시의성 지남',
}

/** Characters as the editor counts them: code points, not UTF-16 units. */
export const charCount = (text: string) => Array.from(text).length

export const statusLabel = (status: string) => CAMPAIGN_STATUS_LABELS[status] ?? status

const sourceOf = (source: string) => SOURCES.find((s) => s.key === source) ?? SOURCES[0]

export const sourceLabel = (source: string) => sourceOf(source).label
export const sourceLinkLabel = (source: string) => sourceOf(source).linkLabel
export const hasEstimatedDeadline = (source: string) => sourceOf(source).estimatedDeadline

export const postStatusLabel = (status: string) => POST_STATUS_LABELS[status] ?? status

const dateTimeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `2026-10-25 14:30` in Asia/Seoul; `-` when empty or not a date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const parts = dateTimeFormat.formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `14:30` in Asia/Seoul; `-` when empty or not a date. */
export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return '-'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '-'
  return timeFormat.format(d)
}

/** `10-25 14:30` in Asia/Seoul (year dropped for dense lists); `-` when empty. */
export function formatShortDateTime(iso: string | null | undefined): string {
  const full = formatDateTime(iso)
  return full === '-' ? full : full.slice(5)
}

const dayFormat =new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** KST calendar day `YYYY-MM-DD`. */
export const kstDay = (d: Date) => dayFormat.format(d)

/** Whole KST calendar days from `now` to `target` (negative once past). */
export function daysUntil(target: string | Date, now: Date = new Date()): number {
  const t = typeof target === 'string' ? new Date(target) : target
  const day = (d: Date) => Date.parse(`${kstDay(d)}T00:00:00Z`)
  return Math.round((day(t) - day(now)) / 86_400_000)
}

export function formatDday(days: number): string {
  if (days === 0) return 'D-day'
  return days > 0 ? `D-${days}` : `D+${-days}`
}

/** `1,234:1` applicants per slot (one decimal below 10:1), `-` when unknown. */
export function formatCompetition(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '-'
  const shown = ratio >= 10 ? Math.round(ratio).toLocaleString('en-US') : ratio.toFixed(1)
  return `${shown}:1`
}

export function competitionOf(c: {
  application_count: number | null
  recruit_count: number | null
}): number | null {
  if (c.application_count == null || !c.recruit_count) return null
  return c.application_count / c.recruit_count
}

export function formatAge(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`
  return `${Math.floor(min / (60 * 24))}일 전`
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

export const formatNumber = (n: number | null | undefined) =>
  n == null ? '-' : n.toLocaleString('en-US')

export const formatWon = (n: number) => `${n.toLocaleString('en-US')}원`

const IMAGE_HOSTS = new Set([
  'st.kakaocdn.net',
  't1.daumcdn.net',
  'img1.kakaocdn.net',
  'gift-s.kakaocdn.net',
  'image.msscdn.net',
])

/** Only https images from the known CDNs are rendered; anything else is ignored. */
export function isAllowedImageUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

/** Only http(s) URLs become links. */
export function isHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const p = new URL(url).protocol
    return p === 'https:' || p === 'http:'
  } catch {
    return false
  }
}

export const VIDEO_STATUS_LABELS: Record<string, string> = {
  UPLOADING: '올리는 중',
  SCRIPTING: '원고 작성',
  RENDERING: '렌더 중',
  PENDING_REVIEW: '검수 대기',
  APPROVED: '승인',
  PUBLISHED: '발행됨',
  REJECTED: '폐기',
  EXPIRED: '만료',
  FAILED: '실패',
}

export const PUBLICATION_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: '예약',
  PUBLISHING: '발행 중',
  PUBLISHED: '발행됨',
  FAILED: '실패',
  CANCELLED: '중단',
}

export const PLATFORM_LABELS: Record<string, string> = {
  REELS: 'Reels',
  SHORTS: 'Shorts',
}

export const videoStatusLabel = (status: string) => VIDEO_STATUS_LABELS[status] ?? status

/** `24초`, `1분 5초`; `-` when unknown. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`
}

/** `12.3MB`, `850KB`; `-` when unknown. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}
