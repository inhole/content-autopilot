import http from 'node:http'
import { isIP } from 'node:net'
import {
  type CampaignActionDeps,
  type CampaignActions,
  createCampaignActions,
} from '../campaigns/actions.ts'
import { GIFT_CAMPAIGN_ID_RE, giftTrialUrl } from '../campaigns/gift.ts'
import { telegramApi } from '../campaigns/tg.ts'
import { config, dashboardEnabled } from '../config.ts'
import {
  createPostActions,
  type PostActionDeps,
  type PostActions,
} from '../pipeline/post-actions.ts'
import { parseScheduleInput } from '../settings.ts'
import { createVideoActions, type VideoActionDeps, type VideoActions } from '../video/actions.ts'
import { UploadBusyError, UploadTooLargeError, uploadMaxBytes } from '../video/upload.ts'
import { type ApiLoaders, handleApi } from './api.ts'
import type {
  AuthSessionResponse,
  OpsJobName,
  OpsProfileConflict,
  OpsProfileInvalid,
  OpsProfileResponse,
  OpsRunResponse,
  OpsScheduleConflict,
  OpsScheduleInvalid,
  OpsScheduleResponse,
} from './api-types.ts'
import {
  type ActiveSession,
  type AdminAction,
  CODE_MAX_ATTEMPTS,
  CODE_REQUESTS_PER_HOUR,
  CODE_TTL_MINUTES,
  type CodeRequestResult,
  csrfFor,
  csrfMatches,
  expireLoginCodes,
  type LoginResult,
  loadSession,
  loginWithCode,
  recordAdminAction,
  requestLoginCode,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
} from './auth.ts'
import { matchCampaignActionPath, runCampaignAction } from './campaign-actions.ts'
import {
  loadCampaignDetail,
  loadCampaignList,
  loadInsights,
  loadOverview,
  loadPostDetail,
  loadRecentPosts,
  loadRevivableList,
} from './data.ts'
import {
  createScheduleEdit,
  dbProfileEdit,
  loadOps,
  type ProfileEdit,
  parseOpsJobName,
  parseProfileInput,
  type ScheduleEdit,
} from './ops.ts'
import {
  matchPostActionPath,
  matchPostCollectionPath,
  type PostActionResult,
  runPostAction,
  runPostCollectionAction,
} from './post-actions.ts'
import { defaultDistDir, hasBuild, lookupStatic } from './static.ts'
import {
  matchVideoRoute,
  runPublicationAction,
  runVideoAction,
  runVideoCreate,
  type VideoRoute,
} from './video-actions.ts'
import { loadVideoDetail, loadVideoList, UPLOAD_TYPES } from './video-data.ts'

export type DashboardLoaders = ApiLoaders

/** Login and session storage (auth.ts); tests pass fakes. */
export type AdminAuth = {
  requestCode(ip: string | null): Promise<CodeRequestResult>
  expireCodes(): Promise<void>
  login(code: string, client: { ip: string | null; userAgent: string | null }): Promise<LoginResult>
  loadSession(token: string): Promise<ActiveSession | null>
  revokeSession(id: number): Promise<void>
  revokeAll(): Promise<number>
  record(action: AdminAction): Promise<void>
}

export type DashboardDeps = {
  loaders: DashboardLoaders
  auth: AdminAuth
  /** Campaign operations (campaigns/actions.ts); tests pass fakes. */
  actions: CampaignActions
  /** Threads operations (pipeline/post-actions.ts); tests pass fakes. */
  postActions: PostActions
  /** Starts an operations job now; false when one is already queued/running or the queue dropped it. */
  runOps: (name: OpsJobName) => Promise<boolean>
  /** Saves or resets the campaign profile (ops.ts); tests pass fakes. */
  profileEdit: ProfileEdit
  /** Saves or resets the schedules and volumes and re-registers the cron jobs (ops.ts). */
  scheduleEdit: ScheduleEdit
  /** Video operations and owner uploads (video/actions.ts); tests pass fakes. */
  videoActions: VideoActions
  /** Sends a text to the owner's Telegram chat; rejects when it cannot. */
  notify: (text: string) => Promise<void>
  now?: () => Date
  /** Directory of the built React app; null disables it. Default: web/dist. */
  webDist?: string | null
}

const dbLoaders: DashboardLoaders = {
  overview: loadOverview,
  campaigns: loadCampaignList,
  campaign: loadCampaignDetail,
  posts: loadRecentPosts,
  insights: loadInsights,
  post: loadPostDetail,
  revivable: loadRevivableList,
  ops: () => loadOps(),
  videos: (filter) => loadVideoList(filter),
  video: loadVideoDetail,
}

const dbAuth: AdminAuth = {
  requestCode: requestLoginCode,
  expireCodes: () => expireLoginCodes(),
  login: loginWithCode,
  loadSession,
  revokeSession,
  revokeAll: revokeAllSessions,
  record: recordAdminAction,
}

/** Hosts campaign thumbnails may be loaded from: the CSP `img-src` allowlist. */
export const IMAGE_HOSTS = [
  'st.kakaocdn.net',
  't1.daumcdn.net',
  'img1.kakaocdn.net',
  'gift-s.kakaocdn.net',
  'image.msscdn.net',
] as const
const IMG_HOSTS = IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')

/** Where the video player may load from: the dashboard and, when set, the Supabase project. */
function mediaHosts(): string {
  if (!config.SUPABASE_URL) return "'self'"
  try {
    return `'self' ${new URL(config.SUPABASE_URL).origin}`
  } catch {
    return "'self'"
  }
}

/** CSP of the React app: same-origin scripts only. */
export const APP_CSP = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${IMG_HOSTS}; media-src ${mediaHosts()} blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

const SECURITY_HEADERS = {
  'Content-Security-Policy': API_CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

const HANDOFF_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Robots-Tag': 'noindex',
}

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Tiny static page that hands a gift campaign over to KakaoTalk's in-app browser. */
export function renderGiftHandoff(campaignId: string): string {
  // Built only from a validated id: the target is always the fixed gift.kakao.com route.
  const web = giftTrialUrl(campaignId)
  const app = `kakaotalk://inappbrowser?url=${encodeURIComponent(web)}`
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${escAttr(app)}">
<title>카카오톡에서 열기</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px 16px;text-align:center;background:#fff;color:#222}
a.primary{display:block;max-width:360px;margin:32px auto 16px;padding:18px;border-radius:12px;background:#fee500;color:#191919;font-size:20px;font-weight:700;text-decoration:none}
a.secondary{display:inline-block;padding:10px;color:#555}
p{color:#666;font-size:14px}
</style></head><body>
<a class="primary" href="${escAttr(app)}">카카오톡에서 열기</a>
<a class="secondary" href="${escAttr(web)}">웹 브라우저로 열기</a>
<p>카카오톡이 설치된 휴대폰에서만 열립니다.</p>
</body></html>`
}

/** Value of one cookie, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

// randomBytes(32) in base64url: anything else is not worth a DB lookup.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_DAYS * 86400}`
const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`

/**
 * Client IP for logs and alerts: the first X-Forwarded-For hop (Railway's proxy) when it is an
 * IP, else the socket. The header is client-supplied and ends up in Telegram messages.
 */
export function clientIp(req: http.IncomingMessage): string | null {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return (first && isIP(first) ? first : req.socket.remoteAddress) ?? null
}

const JSON_TYPES = ['application/json']

/**
 * A state-changing request must come from the dashboard itself: a JSON body (cross-site forms
 * cannot send one without a CORS preflight, which is never answered), an Origin of this host,
 * and, when the browser sends it, Sec-Fetch-Site same-origin.
 */
export function isSameOriginWrite(
  req: http.IncomingMessage,
  types: readonly string[] = JSON_TYPES,
): boolean {
  const type = req.headers['content-type']?.toLowerCase() ?? ''
  if (!types.some((t) => type.startsWith(t))) return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  const origin = req.headers.origin
  if (!origin) return false
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const fwd = req.headers['x-forwarded-host']
  const hosts = [req.headers.host, Array.isArray(fwd) ? fwd[0] : fwd]
  if (config.PUBLIC_BASE_URL) hosts.push(new URL(config.PUBLIC_BASE_URL).host)
  return hosts.includes(host)
}

const BODY_LIMIT = 4096
// Campaign actions carry a memo or a review draft (Korean text, up to 3 bytes per character).
const ACTION_BODY_LIMIT = 16384
// A profile at its limits (five lists of 50 items of 50 Korean chars) is about 40KB.
const PROFILE_BODY_LIMIT = 65536

class BadBody extends Error {}

/** What a write route answers and records in the audit log. */
type WriteResult = Pick<PostActionResult, 'body' | 'result' | 'detail'> & { status: number }

async function readJson(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new BadBody('body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadBody('invalid json')
  }
}

const kst = (d: Date) =>
  new Intl.DateTimeFormat('ko-KR', {
    timeZone: config.TZ_NAME,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(d)

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  send(req, res, status, JSON.stringify(body), extra, 'application/json; charset=utf-8')
}

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  extra: Record<string, string> = {},
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const AUTH_ROUTES: Record<string, 'GET' | 'POST'> = {
  '/api/auth/session': 'GET',
  '/api/auth/code': 'POST',
  '/api/auth/login': 'POST',
  '/api/auth/logout': 'POST',
  '/api/auth/logout-all': 'POST',
}

export function createRequestHandler(deps: DashboardDeps) {
  const nowFn = deps.now ?? (() => new Date())
  const distDir = deps.webDist === undefined ? defaultDistDir() : deps.webDist
  const { auth } = deps

  // Alerts are best effort: a Telegram outage must not turn a login into an error.
  const alert = (text: string) =>
    deps.notify(text).catch((err: unknown) => {
      console.error('dashboard alert failed:', (err as Error).message)
    })

  /** The session of the request's cookie, with its token (for the CSRF check). */
  async function sessionOf(
    req: http.IncomingMessage,
  ): Promise<{ token: string; session: ActiveSession } | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!token || !TOKEN_RE.test(token)) return null
    const session = await auth.loadSession(token)
    return session ? { token, session } : null
  }

  /**
   * The checks every state-changing request passes: same-origin JSON, a live session, and its CSRF
   * token. Answers 403/401 itself and returns null when one fails.
   */
  async function authorizeWrite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    types: readonly string[] = JSON_TYPES,
  ): Promise<{ session: ActiveSession; ip: string | null } | null> {
    if (!isSameOriginWrite(req, types)) {
      sendJson(req, res, 403, { error: '허용되지 않은 요청이에요' })
      return null
    }
    const current = await sessionOf(req)
    if (!current) {
      sendJson(req, res, 401, { error: '로그인이 필요해요' }, { 'Set-Cookie': CLEAR_COOKIE })
      return null
    }
    const csrf = req.headers['x-csrf-token']
    if (!csrfMatches(current.token, Array.isArray(csrf) ? csrf[0] : csrf)) {
      sendJson(req, res, 403, { error: '허용되지 않은 요청이에요' })
      return null
    }
    return { session: current.session, ip: clientIp(req) }
  }

  /** Shared body of every JSON write: authorize, read the body, run, audit. */
  async function handleWrite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { action: string; target: string | null },
    run: (body: unknown) => Promise<WriteResult>,
  ): Promise<void> {
    const authorized = await authorizeWrite(req, res)
    if (!authorized) return
    const { session, ip } = authorized
    const audit = { sessionId: session.id, action: target.action, target: target.target, ip }
    let body: unknown
    try {
      body = await readJson(req, ACTION_BODY_LIMIT)
    } catch (err) {
      if (!(err instanceof BadBody)) throw err
      await auth.record({ ...audit, result: 'invalid' })
      sendJson(req, res, 400, { error: '잘못된 요청이에요' })
      return
    }
    try {
      const r = await run(body)
      await auth.record({ ...audit, result: r.result, detail: r.detail ?? null })
      sendJson(req, res, r.status, r.body)
    } catch (err) {
      await auth.record({ ...audit, result: 'error' }).catch(() => {})
      throw err
    }
  }

  const videoCtx = {
    actions: deps.videoActions,
    loadDetail: deps.loaders.video,
    videoOfPublication: (id: number) => deps.videoActions.videoOfPublication(id),
  }

  /** POST /api/videos, /api/videos/:id/<action>, /api/publications/:id/<action>. */
  const handleVideoWrite = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Exclude<VideoRoute, { kind: 'file' }>,
  ) =>
    handleWrite(
      req,
      res,
      route.kind === 'create'
        ? { action: 'video.create', target: null }
        : route.kind === 'video'
          ? {
              action: `video.${route.action}`,
              target: route.id === null ? null : `video:${route.id}`,
            }
          : {
              action: `publication.${route.action}`,
              target: route.id === null ? null : `publication:${route.id}`,
            },
      (body) =>
        route.kind === 'create'
          ? runVideoCreate(deps.videoActions, body)
          : route.kind === 'video'
            ? runVideoAction(videoCtx, route.action, route.id, body)
            : runPublicationAction(videoCtx, route.action, route.id, body),
    )

  /**
   * POST /api/videos/:id/file: the body is the video itself, streamed to disk by the upload step
   * (docs/plans/video-upload.md 5). A body that is not read (refused before, or the row is not
   * UPLOADING) closes the connection after the answer instead of draining up to 50MB.
   */
  async function handleVideoFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: number | null,
    approve: boolean,
  ): Promise<void> {
    const closeAfterAnswer = () => {
      if (res.writableFinished) req.destroy()
      else res.once('finish', () => req.destroy())
    }
    const refuse = (status: number, body: unknown) => {
      sendJson(req, res, status, body, { Connection: 'close' })
      closeAfterAnswer()
    }
    // An authorized request within the size limit whose body was not read (the row is taken, or
    // another upload runs): read the rest and drop it, so the browser gets the answer instead of
    // a reset connection mid-upload.
    const answerAfterDrain = (status: number, body: unknown) =>
      new Promise<void>((resolve) => {
        const answer = () => {
          if (!res.headersSent) sendJson(req, res, status, body, { Connection: 'close' })
          resolve()
        }
        if (req.readableEnded) answer()
        else req.once('end', answer).once('error', answer).once('close', answer).resume()
      })
    const type = req.headers['content-type']?.toLowerCase() ?? ''
    if (!UPLOAD_TYPES.some((t) => type.startsWith(t))) {
      refuse(415, { error: 'mp4나 mov 파일만 올릴 수 있어요' })
      return
    }
    const authorized = await authorizeWrite(req, res, UPLOAD_TYPES)
    if (!authorized) {
      closeAfterAnswer()
      return
    }
    const audit = {
      sessionId: authorized.session.id,
      action: 'video.file',
      target: id === null ? null : `video:${id}`,
      ip: authorized.ip,
    }
    if (id === null) {
      refuse(404, { error: 'not found' })
      return
    }
    const length = Number(req.headers['content-length'])
    if (!Number.isInteger(length) || length <= 0) {
      await auth.record({ ...audit, result: 'invalid', detail: { reason: 'length' } })
      refuse(411, { error: '파일 크기를 알 수 없어요' })
      return
    }
    const detail = { sizeBytes: length, approve }
    if (length > uploadMaxBytes()) {
      await auth.record({ ...audit, result: 'invalid', detail: { ...detail, reason: 'too_large' } })
      refuse(413, { error: `${Math.round(uploadMaxBytes() / 1024 / 1024)}MB를 넘어요` })
      return
    }
    try {
      const out = await deps.videoActions.receiveFile(id, req, { approve })
      if (out.kind === 'not_uploading') {
        await auth.record({ ...audit, result: 'stale', detail: { ...detail, status: out.status } })
        await answerAfterDrain(409, {
          error: '이미 파일이 들어갔거나 만료된 영상이에요',
          status: out.status,
        })
        return
      }
      if (out.kind === 'rejected') {
        await auth.record({
          ...audit,
          result: 'invalid',
          detail: { ...detail, reason: out.message },
        })
        sendJson(req, res, 400, { error: out.message })
        return
      }
      const approval = out.approval
        ? out.approval.ok
          ? {
              ok: true,
              at: out.approval.approval.at?.toISOString() ?? null,
              platforms: out.approval.approval.platforms,
            }
          : { ok: false, error: out.approval.error }
        : null
      await auth.record({
        ...audit,
        result: 'ok',
        detail: { ...detail, approved: approval?.ok ?? null, telegramSynced: out.telegramSynced },
      })
      sendJson(req, res, 200, {
        ok: true,
        approval,
        telegramSynced: out.telegramSynced,
        detail: await deps.loaders.video(id),
      })
    } catch (err) {
      if (err instanceof UploadBusyError) {
        await auth.record({ ...audit, result: 'busy', detail })
        await answerAfterDrain(429, {
          error: '다른 영상을 올리는 중이에요. 잠시 뒤에 다시 해 주세요',
        })
        return
      }
      if (err instanceof UploadTooLargeError) {
        await auth.record({
          ...audit,
          result: 'invalid',
          detail: { ...detail, reason: 'too_large' },
        })
        refuse(413, { error: `${Math.round(uploadMaxBytes() / 1024 / 1024)}MB를 넘어요` })
        return
      }
      await auth.record({ ...audit, result: 'error', detail }).catch(() => {})
      throw err
    }
  }

  /** POST /api/ops/<name>/run: queue a job by hand. */
  async function handleOpsRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: OpsJobName,
  ): Promise<void> {
    const authorized = await authorizeWrite(req, res)
    if (!authorized) return
    const { session, ip } = authorized
    const audit = { sessionId: session.id, action: `ops.${name}`, target: null, ip }
    const body = await readJson(req, BODY_LIMIT).catch(async (err) => {
      if (!(err instanceof BadBody)) throw err
      return undefined
    })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      await auth.record({ ...audit, result: 'invalid' })
      sendJson(req, res, 400, { error: '잘못된 요청이에요' })
      return
    }
    try {
      const queued = await deps.runOps(name)
      await auth.record({ ...audit, result: 'ok', detail: { queued } })
      sendJson(req, res, queued ? 202 : 200, { ok: true, queued } satisfies OpsRunResponse)
    } catch (err) {
      await auth.record({ ...audit, result: 'error' }).catch(() => {})
      throw err
    }
  }

  /**
   * POST /api/ops/<profile|schedule>[/reset]: save or clear a saved single-row copy on the
   * displayed revision. `apply` returns the invalid fields, or the new state (null when stale).
   */
  async function handleOpsEdit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: string,
    limit: number,
    apply: (
      body: Record<string, unknown>,
      revision: number,
    ) => Promise<{ fields: string[] } | { saved: OpsProfileResponse | OpsScheduleResponse | null }>,
  ): Promise<void> {
    const authorized = await authorizeWrite(req, res)
    if (!authorized) return
    const { session, ip } = authorized
    const audit = { sessionId: session.id, action, target: null, ip }
    const invalid = async (fields: string[], revision?: number) => {
      await auth.record({
        ...audit,
        result: 'invalid',
        ...(revision === undefined ? {} : { detail: { revision } }),
      })
      sendJson(req, res, 400, {
        error: '입력값을 확인해 주세요',
        fields,
      } satisfies OpsProfileInvalid & OpsScheduleInvalid)
    }
    const body = await readJson(req, limit).catch(async (err) => {
      if (!(err instanceof BadBody)) throw err
      return undefined
    })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      await invalid(['revision'])
      return
    }
    const { revision } = body as { revision?: unknown }
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      await invalid(['revision'])
      return
    }
    try {
      const out = await apply(body as Record<string, unknown>, revision)
      if ('fields' in out) {
        await invalid(out.fields, revision)
        return
      }
      if (!out.saved) {
        await auth.record({ ...audit, result: 'stale', detail: { revision } })
        sendJson(req, res, 409, {
          error: '다른 곳에서 먼저 바뀌었어요. 새로 불러올게요',
          stale: true,
        } satisfies OpsProfileConflict & OpsScheduleConflict)
        return
      }
      const detail =
        'applied' in out.saved ? { revision, applied: out.saved.applied } : { revision }
      await auth.record({ ...audit, result: 'ok', detail })
      sendJson(req, res, 200, out.saved)
    } catch (err) {
      await auth.record({ ...audit, result: 'error', detail: { revision } }).catch(() => {})
      throw err
    }
  }

  const editProfile =
    (reset: boolean) => async (body: Record<string, unknown>, revision: number) => {
      if (reset) return { saved: await deps.profileEdit.reset(revision) }
      const parsed = parseProfileInput(body.profile)
      if (!parsed.ok) return { fields: parsed.fields }
      return { saved: await deps.profileEdit.save(parsed.profile, revision) }
    }

  const editSchedule =
    (reset: boolean) => async (body: Record<string, unknown>, revision: number) => {
      if (reset) return { saved: await deps.scheduleEdit.reset(revision) }
      const parsed = parseScheduleInput(body.schedule)
      if (!parsed.ok) return { fields: parsed.fields }
      return { saved: await deps.scheduleEdit.save(parsed.schedule, revision) }
    }

  /** A POST-only write route: 405 for other methods, 400 for a bad body, 500 for anything else. */
  async function writeRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    label: string,
    handle: () => Promise<void>,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' })
      return
    }
    try {
      await handle()
    } catch (err) {
      if (err instanceof BadBody) {
        sendJson(req, res, 400, { error: '잘못된 요청이에요' })
        return
      }
      console.error(`dashboard ${label} failed:`, err)
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' })
      else res.end()
    }
  }

  // One code request or login check at a time per process: each holds a pool connection while
  // it waits on the advisory lock, so a burst of unauthenticated requests could drain the pool.
  let authBusy = false

  /**
   * Runs `fn` (only the DB part: Telegram sends can take minutes and must not hold the flag) unless
   * another code request or login is in flight here; then answers 429 at once and returns undefined.
   */
  async function exclusive<T>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    if (authBusy) {
      sendJson(
        req,
        res,
        429,
        { error: '다른 로그인 요청을 처리하는 중이에요. 잠시 뒤에 다시 해 주세요', retryAfter: 1 },
        { 'Retry-After': '1' },
      )
      return undefined
    }
    authBusy = true
    try {
      return await fn()
    } finally {
      authBusy = false
    }
  }

  /** POST /api/auth/code: issue a code and send it to the owner's Telegram chat. */
  async function handleCodeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string | null,
  ): Promise<void> {
    const r = await exclusive(req, res, () => auth.requestCode(ip))
    if (!r) return
    if (!r.ok) {
      await auth.record({ sessionId: null, action: 'code_request', result: r.reason, ip })
      if (r.reason === 'hourly_limit' && r.firstLimitHit) {
        await alert(
          `⚠️ 관리자 콘솔 로그인 코드 요청이 한 시간 한도(${CODE_REQUESTS_PER_HOUR}회)를 넘었어요\nIP: ${ip ?? '-'}`,
        )
      }
      const message =
        r.reason === 'too_soon'
          ? `${r.retryAfterS}초 뒤에 다시 요청해 주세요`
          : '요청이 너무 많아요. 잠시 뒤에 다시 해 주세요'
      sendJson(
        req,
        res,
        429,
        { error: message, retryAfter: r.retryAfterS },
        {
          'Retry-After': String(r.retryAfterS),
        },
      )
      return
    }
    try {
      await deps.notify(
        `🔐 관리자 콘솔 로그인 코드: ${r.code}\n${CODE_TTL_MINUTES}분 동안 한 번만 쓸 수 있어요\nIP: ${ip ?? '-'}\n직접 요청하지 않았다면 무시하세요`,
      )
    } catch (err) {
      console.error('login code send failed:', (err as Error).message)
      await auth.expireCodes()
      await auth.record({ sessionId: null, action: 'code_request', result: 'send_failed', ip })
      sendJson(req, res, 502, { error: 'Telegram으로 코드를 보내지 못했어요' })
      return
    }
    await auth.record({ sessionId: null, action: 'code_request', result: 'ok', ip })
    sendJson(req, res, 200, { expiresAt: r.expiresAt.toISOString() })
  }

  /** POST /api/auth/login with a well-formed code: check it and open a session. */
  async function handleLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string | null,
    code: string,
  ): Promise<void> {
    const userAgent = req.headers['user-agent'] ?? null
    const r = await exclusive(req, res, () => auth.login(code, { ip, userAgent }))
    if (!r) return
    if (!r.ok) {
      await auth.record({ sessionId: null, action: 'login', result: r.reason, ip })
      if (r.reason === 'locked') {
        if (r.justLocked)
          await alert(
            `⚠️ 관리자 콘솔 로그인 코드를 ${CODE_MAX_ATTEMPTS}번 틀려서 그 코드를 막았어요\nIP: ${ip ?? '-'}`,
          )
        sendJson(req, res, 429, { error: '시도 횟수를 넘었어요. 새 코드를 받아 주세요' })
      } else if (r.reason === 'no_code') {
        sendJson(req, res, 400, { error: '유효한 코드가 없어요. 코드를 다시 받아 주세요' })
      } else if (r.reason === 'wrong') {
        sendJson(req, res, 401, {
          error: `코드가 맞지 않아요 (남은 시도 ${r.attemptsLeft}번)`,
        })
      }
      return
    }
    await auth.record({ sessionId: r.session.id, action: 'login', result: 'ok', ip })
    await alert(`🔐 관리자 콘솔 로그인\n${kst(nowFn())}\nIP: ${ip ?? '-'}`)
    const out: AuthSessionResponse = {
      authenticated: true,
      csrf: r.session.csrf,
      expiresAt: r.session.expiresAt.toISOString(),
    }
    sendJson(req, res, 200, out, { 'Set-Cookie': sessionCookie(r.session.token) })
  }

  async function handleAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<void> {
    const ip = clientIp(req)
    if (path === '/api/auth/session') {
      const current = await sessionOf(req)
      const body: AuthSessionResponse = current
        ? {
            authenticated: true,
            csrf: csrfFor(current.token),
            expiresAt: current.session.expiresAt.toISOString(),
          }
        : { authenticated: false }
      sendJson(req, res, 200, body)
      return
    }
    // Code and login need no session yet, so they only require the same-origin part; logout
    // goes through authorizeWrite below.
    const needsSession = path === '/api/auth/logout' || path === '/api/auth/logout-all'
    if (!needsSession && !isSameOriginWrite(req)) {
      sendJson(req, res, 403, { error: '허용되지 않은 요청이에요' })
      return
    }

    if (path === '/api/auth/code') {
      await handleCodeRequest(req, res, ip)
      return
    }

    if (path === '/api/auth/login') {
      // Read and check the body before taking the busy flag: a slow body must not hold it.
      const body = await readJson(req)
      const code = (body as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        sendJson(req, res, 400, { error: '6자리 숫자 코드를 넣어 주세요' })
        return
      }
      await handleLogin(req, res, ip, code)
      return
    }

    // logout, logout-all: a session and its CSRF token are required.
    const authorized = await authorizeWrite(req, res)
    if (!authorized) return
    const sessionId = authorized.session.id
    if (path === '/api/auth/logout') {
      await auth.revokeSession(sessionId)
      await auth.record({ sessionId, action: 'logout', result: 'ok', ip })
      sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIE })
      return
    }
    const revoked = await auth.revokeAll()
    await auth.record({ sessionId, action: 'logout_all', result: 'ok', ip, detail: { revoked } })
    await alert(`🔐 관리자 콘솔의 모든 세션(${revoked}개)을 끊었어요\nIP: ${ip ?? '-'}`)
    sendJson(req, res, 200, { ok: true, revoked }, { 'Set-Cookie': CLEAR_COOKIE })
  }

  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://dashboard.local')
    } catch {
      send(req, res, 400, 'Bad Request')
      return
    }
    const path = url.pathname
    const isRead = req.method === 'GET' || req.method === 'HEAD'

    if (path.startsWith('/api/auth/') && AUTH_ROUTES[path]) {
      const method = AUTH_ROUTES[path]
      if (method === 'GET' ? !isRead : req.method !== 'POST') {
        sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: method })
        return
      }
      try {
        await handleAuth(req, res, path)
      } catch (err) {
        if (err instanceof BadBody) {
          sendJson(req, res, 400, { error: '잘못된 요청이에요' })
          return
        }
        console.error('dashboard auth request failed:', err)
        sendJson(req, res, 500, { error: 'internal error' })
      }
      return
    }

    const isApi = path === '/api' || path.startsWith('/api/')
    const actionRoute = isApi ? matchCampaignActionPath(path) : null
    if (actionRoute) {
      await writeRoute(req, res, 'campaign action', () =>
        handleWrite(
          req,
          res,
          {
            action: `campaign.${actionRoute.action}`,
            target: actionRoute.id === null ? null : `campaign:${actionRoute.id}`,
          },
          (body) =>
            runCampaignAction(
              { actions: deps.actions, loadDetail: deps.loaders.campaign, now: nowFn() },
              actionRoute.action,
              actionRoute.id,
              body,
            ),
        ),
      )
      return
    }
    const opsEdit = isApi ? /^\/api\/ops\/(profile|schedule)(\/reset)?$/.exec(path) : null
    if (opsEdit) {
      const [, what, reset] = opsEdit
      const action = `ops.${what}${reset ? '.reset' : ''}`
      await writeRoute(req, res, `ops ${what}`, () =>
        what === 'profile'
          ? handleOpsEdit(req, res, action, PROFILE_BODY_LIMIT, editProfile(Boolean(reset)))
          : handleOpsEdit(req, res, action, ACTION_BODY_LIMIT, editSchedule(Boolean(reset))),
      )
      return
    }
    const opsRun = isApi ? /^\/api\/ops\/([^/]+)\/run$/.exec(path) : null
    if (opsRun) {
      const name = parseOpsJobName(opsRun[1] as string)
      if (!name) {
        sendJson(req, res, 404, { error: 'not found' })
        return
      }
      await writeRoute(req, res, 'ops run', () => handleOpsRun(req, res, name))
      return
    }
    // `/api/videos` is also the list (GET): only its POST is the create route.
    const videoRoute = isApi ? matchVideoRoute(path) : null
    if (videoRoute && !(videoRoute.kind === 'create' && isRead)) {
      await writeRoute(req, res, 'video action', () =>
        videoRoute.kind === 'file'
          ? handleVideoFile(req, res, videoRoute.id, url.searchParams.get('approve') === '1')
          : handleVideoWrite(req, res, videoRoute),
      )
      return
    }
    const postRoute = isApi ? matchPostActionPath(path) : null
    const collectionRoute = isApi ? matchPostCollectionPath(path) : null
    if (postRoute || collectionRoute) {
      await writeRoute(req, res, 'post action', async () => {
        if (postRoute) {
          await handleWrite(
            req,
            res,
            {
              action: `post.${postRoute.action}`,
              target: postRoute.id === null ? null : `post:${postRoute.id}`,
            },
            (body) =>
              runPostAction(
                { actions: deps.postActions, loadDetail: deps.loaders.post },
                postRoute.action,
                postRoute.id,
                body,
              ),
          )
        } else if (collectionRoute) {
          await handleWrite(req, res, { action: collectionRoute, target: null }, (body) =>
            runPostCollectionAction(deps.postActions, collectionRoute, body),
          )
        }
      })
      return
    }
    if (!isRead) {
      if (isApi) sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' })
      else send(req, res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }

    if (path === '/healthz') {
      send(req, res, 200, 'ok')
      return
    }
    // Public hand-off to KakaoTalk (the phone's browser has no dashboard session). Strict id only.
    if (path.startsWith('/go/')) {
      const m = /^\/go\/gift\/([^/]+)$/.exec(path)
      if (m?.[1] && GIFT_CAMPAIGN_ID_RE.test(m[1])) {
        send(req, res, 200, renderGiftHandoff(m[1]), HANDOFF_HEADERS, 'text/html; charset=utf-8')
      } else {
        send(req, res, 404, 'Not Found', HANDOFF_HEADERS)
      }
      return
    }

    if (isApi) {
      try {
        if (!(await sessionOf(req))) {
          sendJson(req, res, 401, { error: '로그인이 필요해요' })
          return
        }
        const result = await handleApi(path, url.searchParams, deps.loaders, nowFn())
        sendJson(req, res, result.status, result.body)
      } catch (err) {
        console.error('dashboard api request failed:', err)
        sendJson(req, res, 500, { error: 'internal error' })
      }
      return
    }

    // The app shell and its assets hold no data, so they load without a session: the app shows
    // the login screen until /api/auth/session says otherwise.
    try {
      if (!distDir || !(await hasBuild(distDir))) {
        send(req, res, 503, 'Dashboard build missing: run npm run build:web')
        return
      }
      const file = await lookupStatic(distDir, path)
      if (file === 'bad') send(req, res, 400, 'Bad Request')
      else if (!file) send(req, res, 404, 'Not Found')
      else {
        send(
          req,
          res,
          200,
          file.body,
          {
            'Content-Security-Policy': APP_CSP,
            'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
          },
          file.type,
        )
      }
    } catch (err) {
      console.error('dashboard request failed:', err)
      send(req, res, 500, 'Internal Server Error')
    }
  }
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const handler = createRequestHandler(deps)
  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('dashboard handler crashed:', err)
      if (!res.headersSent) send(req, res, 500, 'Internal Server Error')
      else res.end()
    })
  })
}

/** Sends to the owner's chat; unlike the campaign sender it never falls back to logging. */
async function notifyOwner(text: string): Promise<void> {
  const api = telegramApi()
  const chatId = config.TELEGRAM_CHAT_ID
  if (!api || !chatId) throw new Error('Telegram is not configured')
  await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } })
}

/** Starts the dashboard, or returns null (and says why) when Telegram login is not possible. */
export async function startDashboard(
  campaignDeps: CampaignActionDeps,
  postDeps: PostActionDeps,
  runOps: DashboardDeps['runOps'],
  applyNow: () => Promise<void>,
  videoDeps: VideoActionDeps,
): Promise<{ close(): Promise<void> } | null> {
  if (!dashboardEnabled()) {
    console.log('dashboard disabled: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are needed to log in')
    return null
  }
  const server = createDashboardServer({
    loaders: dbLoaders,
    auth: dbAuth,
    actions: createCampaignActions(campaignDeps),
    postActions: createPostActions(postDeps),
    runOps,
    profileEdit: dbProfileEdit,
    scheduleEdit: createScheduleEdit(applyNow),
    videoActions: createVideoActions(videoDeps),
    notify: notifyOwner,
  })
  const port = config.PORT ?? 8080
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })
  console.log(`dashboard listening on :${port}`)
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
