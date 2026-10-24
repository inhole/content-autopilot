import { z } from 'zod'
import type { AddTopicOutcome, PostActionOutcome, PostActions } from '../pipeline/post-actions.ts'
import { REJECT_REASONS, type RejectReason } from '../pipeline/style.ts'
import type { PostActionName } from './api-types.ts'
import type { PostDetailData } from './data.ts'

/**
 * POST /api/posts/:id/<action>, /api/posts/add, /api/revivable/check and /api/digest
 * (docs/dashboard.md): body validation and the mapping of the outcome to an HTTP answer. Session,
 * CSRF and the audit log are the server's job.
 */

const ID_RE = /^\d{1,15}$/

const revision = z.number().int().min(0).max(2_147_483_647)
// The real limits (500 characters, the CTA room of the last follow-up) are checked by the domain;
// this only caps the body.
const text = z.string().max(2000)
const scheduledAt = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'invalid date' })
      return z.NEVER
    }
    return d
  })

const SCHEMAS = {
  approve: z.object({ revision }),
  reject: z.object({
    revision,
    reason: z.enum(Object.keys(REJECT_REASONS) as [string, ...string[]]),
  }),
  regenerate: z.object({ revision, feedback: z.string().max(1000).optional() }),
  edit: z.object({ revision, idx: z.number().int().min(1).max(3), text }),
  deletePart: z.object({ revision, idx: z.number().int().min(2).max(3) }),
  unschedule: z.object({ scheduledAt }),
  publishNow: z.object({ scheduledAt }),
  retryParts: z.object({}),
  revive: z.object({}),
} satisfies Record<PostActionName, z.ZodType>

const ADD_SCHEMA = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((u) => {
      try {
        const p = new URL(u).protocol
        return p === 'http:' || p === 'https:'
      } catch {
        return false
      }
    }),
  note: z.string().max(500).optional(),
})

export const POST_ACTIONS = Object.keys(SCHEMAS) as PostActionName[]

export const isPostAction = (name: string): name is PostActionName => Object.hasOwn(SCHEMAS, name)

/** `/api/posts/12/approve` → `{ id: 12, action: 'approve' }`; null for any other path. */
export function matchPostActionPath(
  path: string,
): { id: number | null; action: PostActionName } | null {
  const m = /^\/api\/posts\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m || !isPostAction(m[2] as string)) return null
  const idText = m[1] as string
  return { id: ID_RE.test(idText) ? Number(idText) : null, action: m[2] as PostActionName }
}

/** The fixed POST routes that are not tied to one post. */
export type PostCollectionRoute = 'post.add' | 'revive.check' | 'digest.build'

export function matchPostCollectionPath(path: string): PostCollectionRoute | null {
  if (path === '/api/posts/add') return 'post.add'
  if (path === '/api/revivable/check') return 'revive.check'
  if (path === '/api/digest') return 'digest.build'
  return null
}

export type PostActionResult = {
  status: 200 | 202 | 400 | 404 | 409
  body: unknown
  /** For the audit log: ok, stale, invalid, not_found. */
  result: 'ok' | 'stale' | 'invalid' | 'not_found'
  /** Non-sensitive facts for the audit log (never the text, feedback or note). */
  detail?: Record<string, unknown>
}

const BAD_BODY = '요청 내용이 올바르지 않아요'

const invalid = (message: string): PostActionResult => ({
  status: 400,
  body: { error: message },
  result: 'invalid',
})

export type PostActionContext = {
  actions: PostActions
  loadDetail(id: number): Promise<PostDetailData | null>
}

const chars = (s: string) => [...s].length

/** Runs the validated body against the action; the audit `detail` never holds free text. */
async function dispatch(
  actions: PostActions,
  action: PostActionName,
  id: number,
  raw: unknown,
): Promise<{ out: PostActionOutcome; detail?: Record<string, unknown> } | PostActionResult> {
  switch (action) {
    case 'approve': {
      const p = SCHEMAS.approve.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.approve(id, p.data) }
    }
    case 'reject': {
      const p = SCHEMAS.reject.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      const reason = p.data.reason as RejectReason
      return {
        out: await actions.reject(id, { revision: p.data.revision, reason }),
        detail: { reason },
      }
    }
    case 'regenerate': {
      const p = SCHEMAS.regenerate.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return {
        out: await actions.regenerate(id, p.data),
        detail: { feedback: Boolean(p.data.feedback?.trim()) },
      }
    }
    case 'edit': {
      const p = SCHEMAS.edit.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return {
        out: await actions.edit(id, p.data),
        detail: { idx: p.data.idx, chars: chars(p.data.text) },
      }
    }
    case 'deletePart': {
      const p = SCHEMAS.deletePart.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.deletePart(id, p.data), detail: { idx: p.data.idx } }
    }
    case 'unschedule':
    case 'publishNow': {
      const p = SCHEMAS[action].safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      const detail = { scheduledAt: p.data.scheduledAt.toISOString() }
      return { out: await actions[action](id, p.data), detail }
    }
    case 'retryParts': {
      if (!SCHEMAS.retryParts.safeParse(raw).success) return invalid(BAD_BODY)
      return { out: await actions.retryParts(id) }
    }
    case 'revive': {
      if (!SCHEMAS.revive.safeParse(raw).success) return invalid(BAD_BODY)
      return { out: await actions.revive(id) }
    }
  }
}

export async function runPostAction(
  ctx: PostActionContext,
  action: PostActionName,
  id: number | null,
  rawBody: unknown,
): Promise<PostActionResult> {
  if (id === null) return { status: 404, body: { error: 'not found' }, result: 'not_found' }
  const ran = await dispatch(ctx.actions, action, id, rawBody)
  if ('status' in ran) return ran
  const { out, detail } = ran
  if (!out.ok) {
    if (out.reason === 'stale') {
      return { status: 409, result: 'stale', body: { error: out.message, stale: true }, detail }
    }
    if (out.reason === 'not_found') {
      return { status: 404, result: 'not_found', body: { error: 'not found' }, detail }
    }
    return { status: 400, result: 'invalid', body: { error: out.message }, detail }
  }
  const current = await ctx.loadDetail(id)
  return {
    status: 200,
    result: 'ok',
    detail: { ...detail, telegramSynced: out.telegramSynced },
    body: { ok: true, telegramSynced: out.telegramSynced, detail: current },
  }
}

/** POST /api/posts/add, /api/revivable/check, /api/digest. */
export async function runPostCollectionAction(
  actions: PostActions,
  route: PostCollectionRoute,
  rawBody: unknown,
): Promise<PostActionResult> {
  if (route === 'post.add') {
    const p = ADD_SCHEMA.safeParse(rawBody)
    if (!p.success) return invalid('http(s)로 시작하는 기사 주소를 넣어 주세요')
    const note = p.data.note?.trim()
    const out: AddTopicOutcome = await actions.addTopic({
      url: p.data.url,
      ...(note ? { note } : {}),
    })
    const detail = { note: Boolean(note) }
    if (!out.ok) {
      return {
        status: 409,
        result: 'stale',
        detail: { ...detail, postId: out.postId },
        body: { error: `이미 다룬 기사예요 (#${out.postId}, ${out.status})`, postId: out.postId },
      }
    }
    return {
      status: 200,
      result: 'ok',
      detail: { ...detail, topicId: out.topicId },
      body: { ok: true, topicId: out.topicId },
    }
  }
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    return invalid(BAD_BODY)
  }
  if (route === 'revive.check') await actions.reviveCheck()
  else await actions.digest()
  return { status: 202, result: 'ok', body: { ok: true } }
}
