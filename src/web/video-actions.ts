import { z } from 'zod'
import type { VideoActionOutcome, VideoActions } from '../video/actions.ts'
import type { PublicationActionName, VideoActionName } from './api-types.ts'
import type { VideoDetailData } from './video-types.ts'

/**
 * POST /api/videos, /api/videos/:id/<action> and /api/publications/:id/<action>
 * (docs/plans/video-upload.md 6): body validation and the mapping of the outcome to an HTTP
 * answer. The file route (/api/videos/:id/file) streams and is handled by the server. Session,
 * CSRF and the audit log are the server's job.
 */

const ID_RE = /^\d{1,15}$/

const revision = z.number().int().min(0).max(2_147_483_647)
const claimSeq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
// The real limits are checked by the domain (metaProblem); these only cap the body.
const title = z.string().max(500)
const caption = z.string().max(5000)
const hashtags = z.array(z.string().max(100)).max(30)
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
const failedGuard = z.object({ claimSeq, confirmedNotOnChannel: z.boolean().optional() })

const VIDEO_SCHEMAS = {
  approve: z.object({ revision }),
  unapprove: z.object({ revision }),
  reject: z.object({ revision }),
  edit: z.object({ revision, title, caption, hashtags }),
  rescript: z.object({ revision, feedback: z.string().max(1000).optional() }),
  manualDone: z.object({ revision }),
} satisfies Record<VideoActionName, z.ZodType>

const PUBLICATION_SCHEMAS = {
  publishNow: z.object({ scheduledAt }),
  retry: failedGuard,
  cancel: failedGuard,
} satisfies Record<PublicationActionName, z.ZodType>

const httpUrl = z
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
  })

const CREATE_SCHEMA = z.object({
  title,
  caption,
  hashtags,
  sourceUrl: z.union([httpUrl, z.literal(''), z.null()]).optional(),
  originalName: z.string().max(500).nullable().optional(),
})

const isVideoAction = (name: string): name is VideoActionName => Object.hasOwn(VIDEO_SCHEMAS, name)
const isPublicationAction = (name: string): name is PublicationActionName =>
  Object.hasOwn(PUBLICATION_SCHEMAS, name)

export type VideoRoute =
  | { kind: 'create' }
  | { kind: 'file'; id: number | null }
  | { kind: 'video'; id: number | null; action: VideoActionName }
  | { kind: 'publication'; id: number | null; action: PublicationActionName }

const idOf = (text: string) => (ID_RE.test(text) ? Number(text) : null)

/** The POST routes of this module; null for any other path. */
export function matchVideoRoute(path: string): VideoRoute | null {
  if (path === '/api/videos') return { kind: 'create' }
  const v = /^\/api\/videos\/([^/]+)\/([^/]+)$/.exec(path)
  if (v) {
    const action = v[2] as string
    if (action === 'file') return { kind: 'file', id: idOf(v[1] as string) }
    if (isVideoAction(action)) return { kind: 'video', id: idOf(v[1] as string), action }
    return null
  }
  const p = /^\/api\/publications\/([^/]+)\/([^/]+)$/.exec(path)
  if (p && isPublicationAction(p[2] as string)) {
    return { kind: 'publication', id: idOf(p[1] as string), action: p[2] as PublicationActionName }
  }
  return null
}

export type VideoActionResult = {
  status: 200 | 400 | 404 | 409
  body: unknown
  result: 'ok' | 'stale' | 'invalid' | 'not_found'
  /** Non-sensitive facts for the audit log (never title, caption or feedback). */
  detail?: Record<string, unknown>
}

const BAD_BODY = '요청 내용이 올바르지 않아요'
const invalid = (message: string, extra: Record<string, unknown> = {}): VideoActionResult => ({
  status: 400,
  body: { error: message, ...extra },
  result: 'invalid',
})
const notFound = (): VideoActionResult => ({
  status: 404,
  body: { error: 'not found' },
  result: 'not_found',
})

export type VideoActionContext = {
  actions: VideoActions
  loadDetail(id: number): Promise<VideoDetailData | null>
  /** The video a publication belongs to (for the response detail). */
  videoOfPublication(id: number): Promise<number | null>
}

async function toResult(
  ctx: VideoActionContext,
  out: VideoActionOutcome,
  videoId: number | null,
  detail: Record<string, unknown> = {},
): Promise<VideoActionResult> {
  if (!out.ok) {
    if (out.reason === 'stale') {
      return { status: 409, result: 'stale', body: { error: out.message, stale: true }, detail }
    }
    if (out.reason === 'not_found') return { ...notFound(), detail }
    if (out.reason === 'confirm') return { ...invalid(out.message, { confirm: true }), detail }
    return { ...invalid(out.message), detail }
  }
  return {
    status: 200,
    result: 'ok',
    detail: { ...detail, telegramSynced: out.telegramSynced },
    body: {
      ok: true,
      telegramSynced: out.telegramSynced,
      detail: videoId === null ? null : await ctx.loadDetail(videoId),
    },
  }
}

/** POST /api/videos: the upload row. */
export async function runVideoCreate(
  actions: VideoActions,
  raw: unknown,
): Promise<VideoActionResult> {
  const p = CREATE_SCHEMA.safeParse(raw)
  if (!p.success) return invalid(BAD_BODY)
  const out = await actions.create({
    title: p.data.title,
    caption: p.data.caption,
    hashtags: p.data.hashtags,
    sourceUrl: p.data.sourceUrl || null,
    originalName: p.data.originalName ?? null,
  })
  if (!out.ok) return invalid(out.message)
  return {
    status: 200,
    result: 'ok',
    detail: { videoId: out.id },
    body: { ok: true, id: out.id, revision: out.revision },
  }
}

export async function runVideoAction(
  ctx: VideoActionContext,
  action: VideoActionName,
  id: number | null,
  raw: unknown,
): Promise<VideoActionResult> {
  if (id === null) return notFound()
  const { actions } = ctx
  switch (action) {
    case 'edit': {
      const p = VIDEO_SCHEMAS.edit.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return toResult(ctx, await actions.edit(id, p.data), id, { revision: p.data.revision })
    }
    case 'rescript': {
      const p = VIDEO_SCHEMAS.rescript.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return toResult(ctx, await actions.rescript(id, p.data), id, {
        revision: p.data.revision,
        feedback: Boolean(p.data.feedback?.trim()),
      })
    }
    default: {
      const p = VIDEO_SCHEMAS[action].safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      const { revision: rev } = p.data as { revision: number }
      return toResult(ctx, await actions[action](id, { revision: rev }), id, { revision: rev })
    }
  }
}

export async function runPublicationAction(
  ctx: VideoActionContext,
  action: PublicationActionName,
  id: number | null,
  raw: unknown,
): Promise<VideoActionResult> {
  if (id === null) return notFound()
  const videoId = await ctx.videoOfPublication(id)
  if (videoId === null) return notFound()
  if (action === 'publishNow') {
    const p = PUBLICATION_SCHEMAS.publishNow.safeParse(raw)
    if (!p.success) return invalid(BAD_BODY)
    return toResult(ctx, await ctx.actions.publishNow(id, p.data), videoId, {
      scheduledAt: p.data.scheduledAt.toISOString(),
    })
  }
  const p = PUBLICATION_SCHEMAS[action].safeParse(raw)
  if (!p.success) return invalid(BAD_BODY)
  return toResult(ctx, await ctx.actions[action](id, p.data), videoId, {
    claimSeq: p.data.claimSeq,
    confirmed: Boolean(p.data.confirmedNotOnChannel),
  })
}
