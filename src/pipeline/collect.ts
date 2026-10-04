import Parser from 'rss-parser'
import { query } from '../db/pool.ts'
import { urlHash } from '../lib/url.ts'

const parser = new Parser({ timeout: 20_000 })

// Ignore feed items older than this so a newly added feed does not flood the queue.
const MAX_AGE_HOURS = 48

type Source = { id: number; name: string; url: string }

export type CollectResult = { source: string; fetched: number; inserted: number; error?: string }

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
      results.push({ source: source.name, fetched: 0, inserted: 0, error: (err as Error).message })
    }
  }
  return results
}

async function collectSource(source: Source): Promise<CollectResult> {
  const feed = await parser.parseURL(source.url)
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600_000
  let inserted = 0
  for (const item of feed.items) {
    if (!item.link || !item.title) continue
    const published = item.isoDate ? new Date(item.isoDate) : null
    if (published && published.getTime() < cutoff) continue
    const rows = await query(
      `insert into topics (source_id, title, url, url_hash, feed_summary, published_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (url_hash) do nothing
       returning id`,
      [
        source.id,
        item.title.trim(),
        item.link,
        urlHash(item.link),
        item.contentSnippet?.slice(0, 2000) ?? null,
        published,
      ],
    )
    inserted += rows.length
  }
  return { source: source.name, fetched: feed.items.length, inserted }
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
