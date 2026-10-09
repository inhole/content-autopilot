import { parseHTML } from 'linkedom'
import { z } from 'zod'
import { fetchArticle, TransientFetchError } from './article.ts'

// GeekNews returns 403 for short User-Agents, so use the same browser UA as article.ts.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const GEEKNEWS_HOST = 'news.hada.io'
const HN_COMMENT_LIMIT = 5
const HN_COMMENT_CHARS = 400
const HN_TOTAL_CHARS = 1500
const SUMMARY_MAX_CHARS = 4000
const MIN_USABLE_SUMMARY = 200

export type FetchFn = typeof fetch

const parseHttpUrl = (value: string): URL | null => {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

const isGeekNewsUrl = (url: string): boolean => parseHttpUrl(url)?.hostname === GEEKNEWS_HOST

/**
 * Parses a GeekNews topic page. The title link points to the original article (absolute URL) or
 * back to GeekNews for text-only posts, in which case there is no original URL. The summary is
 * GeekNews's own Korean write-up: a reading aid, not the primary source.
 */
export function resolveGeekNews(html: string): { originalUrl?: string; summary?: string } {
  const { document } = parseHTML(html)
  const result: { originalUrl?: string; summary?: string } = {}

  const href = document.querySelector('a.topic-title-link')?.getAttribute('href')?.trim()
  if (href) {
    // Relative hrefs fail to parse without a base, so they are dropped here.
    const u = parseHttpUrl(href)
    if (u && u.hostname !== GEEKNEWS_HOST) result.originalUrl = u.toString()
  }

  const text = document
    .querySelector('#topic_contents')
    ?.textContent?.replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  if (text) result.summary = text.slice(0, SUMMARY_MAX_CHARS)
  return result
}

const hnItemSchema = z.object({
  children: z.array(z.object({ text: z.string().nullable().optional() }).passthrough()).optional(),
})

function htmlToText(html: string): string {
  // HN comments use <p> as paragraph separators and <pre><code> for code.
  const { document } = parseHTML(`<div>${html.replace(/<p>/gi, '\n\n')}</div>`)
  return (document.querySelector('div')?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Top-level comments of an HN thread via the Algolia API, as plain text. Best effort: any
 * failure (bad URL, network, timeout, schema change) yields [] because comments are optional
 * context and must never block drafting.
 */
export async function fetchHnComments(
  discussionUrl: string | null | undefined,
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  if (!discussionUrl) return []
  try {
    const u = parseHttpUrl(discussionUrl)
    const id = u?.searchParams.get('id')
    if (u?.hostname !== 'news.ycombinator.com' || !id || !/^\d+$/.test(id)) return []
    const res = await fetchFn(`https://hn.algolia.com/api/v1/items/${id}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const item = hnItemSchema.parse(await res.json())
    const out: string[] = []
    let total = 0
    for (const child of item.children ?? []) {
      if (out.length >= HN_COMMENT_LIMIT || total >= HN_TOTAL_CHARS) break
      if (!child.text) continue // deleted/dead comments have null text
      const text = htmlToText(child.text).slice(0, HN_COMMENT_CHARS).trim()
      if (!text) continue
      out.push(text)
      total += text.length
    }
    return out
  } catch {
    return []
  }
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string | null> {
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

export type SourceTopic = {
  id?: number
  title: string
  url: string | null
  discussion_url: string | null
  feed_summary: string | null
}

export type GatheredSources = {
  /** Text the draft's facts must come from. */
  body: string
  /** Best link to attach to the post (the original article when known). */
  sourceUrl: string | null
  /** Labeled extra context that is not a source of facts. */
  aux: { label: string; text: string }[]
}

export type SourceDeps = {
  fetchArticle?: typeof fetchArticle
  fetchFn?: FetchFn
}

/**
 * Collects the grounding body, attach link and extra context for a topic. Returns null when
 * nothing readable exists; throws TransientFetchError when the only obstacle was a transient
 * fetch failure, so the job retries instead of skipping the topic for good.
 */
export async function gatherSources(
  topic: SourceTopic,
  deps: SourceDeps = {},
): Promise<GatheredSources | null> {
  const getArticle = deps.fetchArticle ?? fetchArticle
  const fetchFn = deps.fetchFn ?? fetch

  let gnSummary: string | undefined
  let sourceUrl = topic.url
  let articleUrl = topic.url
  if (topic.url && isGeekNewsUrl(topic.url)) {
    const html = await fetchHtml(topic.url, fetchFn)
    if (html) {
      const gn = resolveGeekNews(html)
      gnSummary = gn.summary
      if (gn.originalUrl) {
        sourceUrl = gn.originalUrl
        articleUrl = gn.originalUrl
      }
    }
  }

  let transient: TransientFetchError | null = null
  let articleText: string | undefined
  if (articleUrl) {
    try {
      articleText = (await getArticle(articleUrl))?.text
    } catch (err) {
      // Fall back to a summary below. A transient failure with no usable fallback must retry
      // the job instead of skipping the topic for good.
      if (err instanceof TransientFetchError) transient = err
      else console.warn(`[generate] topic ${topic.id ?? '?'}: ${(err as Error).message}`)
    }
  }

  const comments = await fetchHnComments(topic.discussion_url, fetchFn)
  const aux: GatheredSources['aux'] = []
  const addComments = () => {
    if (comments.length > 0)
      aux.push({
        label: 'HN 댓글 (개발자 반응, 사실 근거 아님)',
        text: comments.map((c, i) => `${i + 1}. ${c}`).join('\n'),
      })
  }

  if (articleText) {
    // Without an original link the GeekNews page itself was read as the body, so the summary
    // would only repeat it.
    if (gnSummary && articleUrl !== topic.url)
      aux.push({ label: 'GeekNews 요약 (참고)', text: gnSummary })
    addComments()
    return { body: articleText, sourceUrl, aux }
  }

  const feed = topic.feed_summary?.trim()
  const fallback =
    gnSummary && gnSummary.length >= MIN_USABLE_SUMMARY
      ? gnSummary
      : feed && feed.length >= MIN_USABLE_SUMMARY
        ? feed
        : undefined
  if (fallback) {
    addComments()
    return { body: fallback, sourceUrl, aux }
  }
  // Manual topics without a URL: the title itself is the brief.
  if (!topic.url) return { body: topic.title, sourceUrl: null, aux }
  if (transient) throw transient
  return null
}
