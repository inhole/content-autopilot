import { query } from '../db/pool.ts'
import { MATURE_VIEWS_JOIN, median } from './insights.ts'
import { PROMPT_VERSION } from './prompts.ts'

/** Reject reason codes (stored in posts.reject_reason) and their Korean button labels. */
export const REJECT_REASONS = {
  fact: '사실 오류',
  boring: '재미없음',
  topic: '주제 별로',
  dup: '중복',
  other: '기타',
} as const
export type RejectReason = keyof typeof REJECT_REASONS

export const isRejectReason = (v: string): v is RejectReason => Object.hasOwn(REJECT_REASONS, v)

/** One guidance sentence per reason, shown to the generator when that reason dominates. */
const REASON_GUIDANCE: Record<RejectReason, string> = {
  fact: '사실 관계가 틀렸다는 이유로 폐기된 적이 많아요. 기사 본문에 없는 수치·주장은 쓰지 마세요.',
  boring: '재미없다는 이유로 폐기된 적이 많아요. 첫 줄을 구체적인 사실이나 수치로 시작하세요.',
  topic:
    '주제가 별로라는 이유로 폐기된 적이 많아요. 개발자에게 실질적 영향이 있는 관점을 고르세요.',
  dup: '이미 다룬 내용과 겹친다는 이유로 폐기된 적이 많아요. 기존 글과 다른 각도를 잡으세요.',
  other: '',
}

export type StyleContext = {
  examples: { text: string; edited: boolean }[]
  /** First lines of the best-viewed recent posts of the same format (decision 16). */
  topFirstLines?: string[]
  recentFirstLines: string[]
  recentLastLines: string[]
  rejectReasons: { reason: string; count: number }[]
}

export type StyleLimits = {
  examples?: number
  recent?: number
  rejectDays?: number
  /** The format of the draft being written; top first lines come from that format only. */
  chain?: boolean
}

// Performance learning needs this many measured posts of the format, or it would learn noise.
const TOP_MIN_POSTS = 6
const TOP_SHOWN = 3
const TOP_DAYS = 30

/**
 * First lines of the best posts: up to three above the median, and none until enough posts of the
 * format are measured. `rows` is every measured post of the format with its views.
 */
export function pickTopFirstLines(rows: { text: string; views: number }[]): string[] {
  if (rows.length < TOP_MIN_POSTS) return []
  const mid = median(rows.map((r) => r.views))
  return rows
    .filter((r) => r.views > mid)
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_SHOWN)
    .map((r) => firstLine(r.text))
    .filter(Boolean)
}

const nonEmptyLines = (text: string) => text.split('\n').filter((l) => l.trim())
const firstLine = (text: string) => (nonEmptyLines(text)[0] ?? '').trim()
// '' for a one-line post: its only line is already listed as a first line.
const lastLine = (text: string) => {
  const lines = nonEmptyLines(text)
  return lines.length > 1 ? (lines.at(-1) ?? '').trim() : ''
}

export async function loadStyleContext(limits: StyleLimits = {}): Promise<StyleContext> {
  const { examples = 3, recent = 10, rejectDays = 30, chain = false } = limits
  // Owner-edited posts first: a 수정: reply is the clearest signal of the voice the owner wants.
  // Only posts written under the current prompt voice (generation.prompt_version >= 2) count:
  // older posts are 음슴체 with a closing question and would pull the draft back to that style.
  // The regex guard keeps a malformed value from failing the cast.
  const ex = await query<{ text: string; edited: boolean }>(
    `select text, (generation->>'text') is distinct from text as edited
     from posts where status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED')
       and case when generation->>'prompt_version' ~ '^[0-9]+$'
                then (generation->>'prompt_version')::int >= 2 else false end
     order by edited desc, id desc limit $1`,
    [examples],
  )
  const rec = await query<{ text: string }>(
    "select text from posts where status <> 'EXPIRED' order by id desc limit $1",
    [recent],
  )
  const rej = await query<{ reason: string; count: number }>(
    `select reject_reason as reason, count(*) as count from posts
     where status = 'REJECTED' and reject_reason is not null
       and updated_at > now() - make_interval(days => $1)
     group by reject_reason order by count(*) desc`,
    [rejectDays],
  )
  // Same population as the format experiment in the weekly report: news posts in the current
  // voice, by views a day or more after publishing.
  const measured = await query<{ text: string; views: number }>(
    `select p.text, mv.views from posts p
     ${MATURE_VIEWS_JOIN}
     where p.status = 'PUBLISHED' and p.origin = 'news' and mv.views is not null
       and p.published_at > now() - make_interval(days => $1)
       and p.generation->>'prompt_version' = $2
       and exists (select 1 from post_parts pp
                   where pp.post_id = p.id and pp.status = 'PUBLISHED') = $3`,
    [TOP_DAYS, String(PROMPT_VERSION), chain],
  )
  return {
    examples: ex,
    topFirstLines: pickTopFirstLines(measured),
    recentFirstLines: rec.map((r) => firstLine(r.text)).filter(Boolean),
    recentLastLines: rec.map((r) => lastLine(r.text)).filter(Boolean),
    rejectReasons: rej,
  }
}

const EXAMPLE_MAX = 280
const FIRST_LINE_MAX = 60
const LAST_LINE_MAX = 60
// Closing lines only need to break the most recent pattern, so fewer are sent than first lines.
const LAST_LINE_COUNT = 5
const TOTAL_MAX = 2200
// A reason needs at least this many rejections to count as a pattern rather than noise.
const MIN_REASON_COUNT = 2

const clip = (s: string, max: number) => {
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

/** Korean prompt fragment for the generator; '' when there is nothing to learn from yet. */
export function buildStylePrompt(ctx: StyleContext): string {
  const parts: string[] = []

  if (ctx.examples.length) {
    const items = ctx.examples.map(
      (e, i) => `[예시 ${i + 1}${e.edited ? ' · 직접 수정함' : ''}]\n${clip(e.text, EXAMPLE_MAX)}`,
    )
    parts.push(
      `## 문체 참고\n아래는 승인된 과거 글이에요. 단어 선택과 문장 리듬만 참고하세요. 어미는 작성 규칙의 반말을 따르고, 예시의 어미가 규칙과 다르면 어미는 따라 하지 마세요. 첫 줄과 마무리 같은 구성은 작성 규칙을 따르고, 문장이나 사실을 그대로 가져오지 마세요.\n\n${items.join('\n\n')}`,
    )
  }

  if (ctx.topFirstLines?.length) {
    const lines = ctx.topFirstLines.map((l) => `- ${clip(l, FIRST_LINE_MAX)}`)
    parts.push(
      `## 반응 좋았던 첫 줄\n최근 조회가 많았던 글의 첫 줄이에요. 문장을 가져오지 말고, 독자를 멈추게 한 방식만 참고하세요.\n${lines.join('\n')}`,
    )
  }

  if (ctx.recentFirstLines.length) {
    const lines = ctx.recentFirstLines.map((l) => `- ${clip(l, FIRST_LINE_MAX)}`)
    parts.push(`## 최근 첫 줄\n아래와 비슷한 첫 줄로 시작하지 마세요.\n${lines.join('\n')}`)
  }

  if (ctx.recentLastLines.length) {
    const lines = ctx.recentLastLines
      .slice(0, LAST_LINE_COUNT)
      .map((l) => `- ${clip(l, LAST_LINE_MAX)}`)
    parts.push(`## 최근 마지막 줄\n아래와 비슷한 마무리는 피하세요.\n${lines.join('\n')}`)
  }

  const guidance = ctx.rejectReasons
    .filter((r) => r.count >= MIN_REASON_COUNT && isRejectReason(r.reason))
    .map((r) => REASON_GUIDANCE[r.reason as RejectReason])
    .filter(Boolean)
  if (guidance.length) parts.push(`## 최근 폐기 사유\n${guidance.map((g) => `- ${g}`).join('\n')}`)

  const out = parts.join('\n\n')
  // Hard cap so a long history can never crowd out the article body in the prompt.
  return [...out].length > TOTAL_MAX ? `${[...out].slice(0, TOTAL_MAX - 1).join('')}…` : out
}
