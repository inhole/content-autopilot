import { createHash } from 'node:crypto'

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid)$/i

/** Canonical form used for duplicate detection: no tracking params, fragment, or trailing slash. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim())
  url.hash = ''
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

export function urlHash(raw: string): string {
  return createHash('sha256').update(normalizeUrl(raw)).digest('hex')
}
