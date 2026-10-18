/** Escaping and layout helpers for the read-only dashboard. Everything dynamic goes through `esc`. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only absolute http(s) URLs are linkable; anything else (javascript:, data:, relative) is not. */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** An external link when `url` is http(s), otherwise escaped plain text. */
export function extLink(url: string | null | undefined, label?: string): string {
  if (!url) return '-'
  const text = esc(label ?? url)
  if (!isHttpUrl(url)) return text
  return `<a href="${esc(url)}" rel="noreferrer noopener" target="_blank">${text}</a>`
}

/** Hosts campaign thumbnails may be loaded from; also the CSP `img-src` allowlist. */
export const IMAGE_HOSTS = [
  'st.kakaocdn.net',
  't1.daumcdn.net',
  'img1.kakaocdn.net',
  'gift-s.kakaocdn.net',
] as const

/** Only https images on an allowlisted host (no credentials, default port) may be embedded. */
export function isAllowedImageUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      u.port === '' &&
      (IMAGE_HOSTS as readonly string[]).includes(u.hostname)
    )
  } catch {
    return false
  }
}

export function formatDateTime(d: Date | null | undefined, tz: string): string {
  if (!d) return '-'
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** `3분 전`, `2시간 전`, `5일 전`. */
export function formatAge(from: Date, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000))
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`
  return `${Math.floor(min / (60 * 24))}일 전`
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

const CSS = `
:root{--bg:#f6f7f9;--fg:#1d2127;--muted:#667085;--card:#fff;--line:#e3e6ea;--accent:#2f6fed;--warn:#b42318;--warnbg:#fdecea;--ok:#067647;--okbg:#e7f6ee}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa3ae;--card:#1d2026;--line:#2f343c;--accent:#7aa2ff;--warn:#ff8a80;--warnbg:#3a1d1b;--ok:#6ad39a;--okbg:#17321f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Noto Sans KR",sans-serif}
a{color:var(--accent)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
header strong{margin-right:auto}
main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:20px 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;text-decoration:none;color:inherit;display:block}
.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:var(--line)}
.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.ok{background:var(--okbg);color:var(--ok)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chips a{padding:3px 10px;border:1px solid var(--line);border-radius:14px;text-decoration:none;font-size:13px;background:var(--card)}
.chips a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card)}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
th{color:var(--muted);font-weight:500;white-space:nowrap}
@media (max-width:640px){
 table.cards-m thead{display:none}
 table.cards-m,table.cards-m tbody,table.cards-m tr,table.cards-m td{display:block;width:100%}
 table.cards-m tr{border:1px solid var(--line);border-radius:8px;margin-bottom:8px;padding:6px 8px}
 table.cards-m td{border:0;padding:2px 0}
 table.cards-m td[data-label]::before{content:attr(data-label) " ";color:var(--muted);font-size:12px}
}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:6px;font-size:12px}}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit}
.muted{color:var(--muted)}
.empty{color:var(--muted);padding:12px 0}
`

export type LayoutOptions = { title: string; refresh?: boolean }

export function layout(body: string, opts: LayoutOptions): string {
  const refresh = opts.refresh ? '<meta http-equiv="refresh" content="60">' : ''
  const links: [string, string][] = [
    ['/', '현황'],
    ['/campaigns', '체험단'],
    ['/posts', 'Threads 글'],
  ]
  const nav = links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${esc(opts.title)} · Autopilot</title>
<style>${CSS}</style></head>
<body><header><strong>Content Autopilot</strong>${nav}</header>
<main>${body}</main></body></html>`
}
