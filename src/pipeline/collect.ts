import Parser from 'rss-parser'
import { query } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'

const parser = new Parser({ timeout: 20_000 })

// Topics older than this are never collected or ranked: news does not carry over.
export const MAX_AGE_HOURS = 48

type Source = { id: number; name: string; url: string }

export type CollectResult = {
  source: string
  fetched: number
  inserted: number
  skipped: number
  error?: string
}

export type NormalizedItem = {
  title: string
  url: string
  urlHash: string
  summary: string | null
  publishedAt: Date | null
}

// rss-parser types these as strings, but e.g. `<title xml:lang="ko"/>` parses to an object.
type RawItem = { link?: unknown; title?: unknown; isoDate?: unknown; contentSnippet?: unknown }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Validates one feed item. Returns null when it cannot be stored (missing title/link, bad or
 * non-http(s) URL), so a single bad item never aborts the feed. Relative links are resolved
 * against `base` (the feed's site link or feed URL). An unparseable date becomes null.
 */
export function normalizeItem(item: RawItem, base: string): NormalizedItem | null {
  const title = str(item.title)?.trim()
  const link = str(item.link)?.trim()
  if (!title || !link) return null
  let url: string
  let hash: string
  try {
    const parsed = new URL(link, base)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    url = parsed.toString()
    hash = urlHash(url)
  } catch {
    return null
  }
  let publishedAt: Date | null = null
  const isoDate = str(item.isoDate)
  if (isoDate) {
    const d = new Date(isoDate)
    if (!Number.isNaN(d.getTime())) publishedAt = d
  }
  return {
    title,
    url,
    urlHash: hash,
    summary: str(item.contentSnippet)?.slice(0, 2000) ?? null,
    publishedAt,
  }
}

export async function collectAll(): Promise<CollectResult[]> {
  const sources = await query<Source>(
    "select id, name, url from sources where kind = 'RSS' and enabled order by id",
  )
  const results: CollectResult[] = []
  // One failing feed must not stop the others.
  for (const source of sources) {
    try {
      results.push(await collectSource(source))
    } catch (err) {
      results.push({
        source: source.name,
        fetched: 0,
        inserted: 0,
        skipped: 0,
        error: (err as Error).message,
      })
    }
  }
  return results
}

async function collectSource(source: Source): Promise<CollectResult> {
  const feed = await parser.parseURL(source.url)
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600_000
  const base = feed.link ?? source.url
  let inserted = 0
  let skipped = 0
  for (const raw of feed.items) {
    let item: NormalizedItem | null
    try {
      item = normalizeItem(raw, base)
    } catch {
      item = null
    }
    if (!item) {
      skipped++
      continue
    }
    if (item.publishedAt && item.publishedAt.getTime() < cutoff) continue
    const rows = await query(
      `insert into topics (source_id, title, url, url_hash, feed_summary, published_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (url_hash) do nothing
       returning id`,
      [source.id, item.title, item.url, item.urlHash, item.summary, item.publishedAt],
    )
    inserted += rows.length
  }
  return { source: source.name, fetched: feed.items.length, inserted, skipped }
}

/** Skips COLLECTED topics that aged out before being ranked (e.g. the worker was down). */
export async function expireStaleTopics(): Promise<number> {
  const rows = await query(
    `update topics set status = 'SKIPPED', updated_at = now()
     where status = 'COLLECTED'
       and coalesce(published_at, created_at) < now() - make_interval(hours => $1)
     returning id`,
    [MAX_AGE_HOURS],
  )
  return rows.length
}

export async function addManualTopic(title: string, url?: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into topics (source_id, title, url, url_hash, status)
     values ((select id from sources where kind = 'MANUAL' limit 1), $1, $2, $3, 'SHORTLISTED')
     on conflict (url_hash) do update set status = 'SHORTLISTED', updated_at = now()
     returning id`,
    [title, url ?? null, url ? urlHash(url) : null],
  )
  const row = rows[0]
  if (!row) throw new Error('failed to insert manual topic')
  return row.id
}
