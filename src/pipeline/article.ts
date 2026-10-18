import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

const MAX_CHARS = 12_000

export type Article = { title: string; text: string }

/** A failure that may succeed on retry (429, 5xx, network error, timeout). */
export class TransientFetchError extends Error {}

/** 'permanent' statuses mean the page will not become readable by retrying. */
export function classifyStatus(status: number): 'ok' | 'transient' | 'permanent' {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 429 || status === 408 || status >= 500) return 'transient'
  return 'permanent'
}

// Bot-check interstitials answer 200 with a "making sure you're not a bot" page instead of the
// article, and Readability happily extracts that notice as the body (seen with lore.kernel.org).
// Matched on markup only these pages have (element ids, asset paths, exact titles), never on
// words an article about them could contain. Cloudflare's /cdn-cgi/challenge-platform/ script
// also runs on normal pages, so only its challenge options object counts.
const BOT_CHALLENGE_MARKERS = [
  /id=["']anubis_challenge["']/i,
  /\/\.within\.website\/x\/cmd\/anubis\//i,
  /window\._cf_chl_opt/,
  /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>/i,
]

export function isBotChallenge(html: string): boolean {
  return BOT_CHALLENGE_MARKERS.some((m) => m.test(html))
}

/**
 * Fetches a page and extracts its main text. Returns null for permanent outcomes (non-HTML,
 * too short, a bot-check page, 4xx other than 408/429) and throws TransientFetchError for retryable ones.
 */
export async function fetchArticle(url: string): Promise<Article | null> {
  let html: string
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    const kind = classifyStatus(res.status)
    if (kind === 'transient') throw new TransientFetchError(`fetch ${url} failed: ${res.status}`)
    if (kind === 'permanent') return null
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null
    html = await res.text()
  } catch (err) {
    if (err instanceof TransientFetchError) throw err
    // fetch rejects on DNS/connection errors and timeouts; body reads can fail too.
    throw new TransientFetchError(`fetch ${url} failed: ${(err as Error).message}`)
  }

  // A retry meets the same check, so it is unreadable rather than transient.
  if (isBotChallenge(html)) {
    console.warn(`[article] ${url}: bot-check page instead of the article`)
    return null
  }

  const { document } = parseHTML(html)
  const parsed = new Readability(document as unknown as Document).parse()
  const text = parsed?.textContent?.replace(/\n{3,}/g, '\n\n').trim()
  if (!text || text.length < 200) return null
  return { title: parsed?.title ?? '', text: text.slice(0, MAX_CHARS) }
}
