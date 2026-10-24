import { z } from 'zod'
import type { ActionOutcome, CampaignActions } from '../campaigns/actions.ts'
import { parseDueDate } from '../campaigns/telegram.ts'
import {
  CAMPAIGN_REJECT_REASONS,
  CAMPAIGN_STATUSES,
  type CampaignRejectReason,
} from '../campaigns/types.ts'
import { config } from '../config.ts'
import type { CampaignActionName } from './api-types.ts'
import type { CampaignDetailData } from './data.ts'

/**
 * POST /api/campaigns/:id/<action> (docs/dashboard.md): body validation and the mapping of the
 * action's outcome to an HTTP answer. Session, CSRF and the audit log are the server's job.
 */

const ID_RE = /^\d{1,15}$/

const revision = z.number().int().min(0).max(2_147_483_647)
const status = z.enum(CAMPAIGN_STATUSES)

const SCHEMAS = {
  apply: z.object({ revision }),
  reject: z.object({
    revision,
    reason: z.enum(Object.keys(CAMPAIGN_REJECT_REASONS) as [string, ...string[]]),
  }),
  result: z.object({ selected: z.boolean() }),
  deadline: z.object({ status, date: z.string().trim().min(1).max(40) }),
  memo: z.object({ status, revision, memo: z.string().max(2000) }),
  regenerate: z.object({ revision, feedback: z.string().max(1000).optional() }),
  draft: z.object({ revision, text: z.string().max(3000) }),
  posted: z.object({ revision }),
} satisfies Record<CampaignActionName, z.ZodType>

export const CAMPAIGN_ACTIONS = Object.keys(SCHEMAS) as CampaignActionName[]

export const isCampaignAction = (name: string): name is CampaignActionName =>
  Object.hasOwn(SCHEMAS, name)

/** `/api/campaigns/12/apply` → `{ id: 12, action: 'apply' }`; null for any other path. */
export function matchCampaignActionPath(
  path: string,
): { id: number | null; action: CampaignActionName } | null {
  const m = /^\/api\/campaigns\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m || !isCampaignAction(m[2] as string)) return null
  const idText = m[1] as string
  return { id: ID_RE.test(idText) ? Number(idText) : null, action: m[2] as CampaignActionName }
}

export type CampaignActionResult = {
  status: 200 | 400 | 404 | 409
  body: unknown
  /** For the audit log: ok, stale, invalid, not_found. */
  result: 'ok' | 'stale' | 'invalid' | 'not_found'
  /** Non-sensitive facts for the audit log (never the memo or draft text). */
  detail?: Record<string, unknown>
}

const BAD_BODY = '요청 내용이 올바르지 않아요'

const invalid = (message: string): CampaignActionResult => ({
  status: 400,
  body: { error: message },
  result: 'invalid',
})

export type CampaignActionContext = {
  actions: CampaignActions
  loadDetail(id: number): Promise<CampaignDetailData | null>
  now: Date
}

/** Runs the validated body against the action; the audit `detail` never holds memo or draft text. */
async function dispatch(
  actions: CampaignActions,
  action: CampaignActionName,
  id: number,
  raw: unknown,
  now: Date,
): Promise<{ out: ActionOutcome; detail?: Record<string, unknown> } | CampaignActionResult> {
  switch (action) {
    case 'apply': {
      const p = SCHEMAS.apply.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.apply(id, p.data) }
    }
    case 'reject': {
      const p = SCHEMAS.reject.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      const reason = p.data.reason as CampaignRejectReason
      return {
        out: await actions.reject(id, { revision: p.data.revision, reason }),
        detail: { reason },
      }
    }
    case 'result': {
      const p = SCHEMAS.result.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.result(id, p.data), detail: { selected: p.data.selected } }
    }
    case 'deadline': {
      const p = SCHEMAS.deadline.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      const deadline = parseDueDate(p.data.date, now, config.TZ_NAME)
      if (!deadline) {
        return invalid('날짜를 읽을 수 없어요. 10/30 또는 2026-10-30 처럼 적어 주세요')
      }
      return {
        out: await actions.deadline(id, { status: p.data.status, deadline }),
        detail: { deadline: deadline.toISOString() },
      }
    }
    case 'memo': {
      const p = SCHEMAS.memo.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.memo(id, p.data), detail: { chars: [...p.data.memo].length } }
    }
    case 'regenerate': {
      const p = SCHEMAS.regenerate.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return {
        out: await actions.regenerate(id, p.data),
        detail: { feedback: Boolean(p.data.feedback?.trim()) },
      }
    }
    case 'draft': {
      const p = SCHEMAS.draft.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.draft(id, p.data), detail: { chars: [...p.data.text].length } }
    }
    case 'posted': {
      const p = SCHEMAS.posted.safeParse(raw)
      if (!p.success) return invalid(BAD_BODY)
      return { out: await actions.posted(id, p.data) }
    }
  }
}

export async function runCampaignAction(
  ctx: CampaignActionContext,
  action: CampaignActionName,
  id: number | null,
  rawBody: unknown,
): Promise<CampaignActionResult> {
  if (id === null) return { status: 404, body: { error: 'not found' }, result: 'not_found' }
  const ran = await dispatch(ctx.actions, action, id, rawBody, ctx.now)
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
