import { query } from '../db/pool.ts'

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
  recentFirstLines: string[]
  rejectReasons: { reason: string; count: number }[]
}

export type StyleLimits = { examples?: number; recent?: number; rejectDays?: number }

const firstLine = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').trim()

export async function loadStyleContext(limits: StyleLimits = {}): Promise<StyleContext> {
  const { examples = 3, recent = 10, rejectDays = 30 } = limits
  // Owner-edited posts first: a 수정: reply is the clearest signal of the voice the owner wants.
  const ex = await query<{ text: string; edited: boolean }>(
    `select text, (generation->>'text') is distinct from text as edited
     from posts where status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED')
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
  return {
    examples: ex,
    recentFirstLines: rec.map((r) => firstLine(r.text)).filter(Boolean),
    rejectReasons: rej,
  }
}

const EXAMPLE_MAX = 280
const FIRST_LINE_MAX = 60
const TOTAL_MAX = 1500
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
      `## 문체 참고\n아래는 승인된 과거 글이에요. 말투와 구조만 참고하고, 문장이나 사실을 그대로 가져오지 마세요.\n\n${items.join('\n\n')}`,
    )
  }

  if (ctx.recentFirstLines.length) {
    const lines = ctx.recentFirstLines.map((l) => `- ${clip(l, FIRST_LINE_MAX)}`)
    parts.push(`## 최근 첫 줄\n아래와 비슷한 첫 줄로 시작하지 마세요.\n${lines.join('\n')}`)
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
