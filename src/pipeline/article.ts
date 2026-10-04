import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

const MAX_CHARS = 12_000

export type Article = { title: string; text: string }

/** Fetches a page and extracts its main text. Returns null when nothing readable is found. */
export async function fetchArticle(url: string): Promise<Article | null> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
  if (!(res.headers.get('content-type') ?? '').includes('html')) return null

  const { document } = parseHTML(await res.text())
  const parsed = new Readability(document as unknown as Document).parse()
  const text = parsed?.textContent?.replace(/\n{3,}/g, '\n\n').trim()
  if (!text || text.length < 200) return null
  return { title: parsed?.title ?? '', text: text.slice(0, MAX_CHARS) }
}
