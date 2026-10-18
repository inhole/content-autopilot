import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { config } from '../config.ts'
import { type ApiLoaders, handleApi } from './api.ts'
import {
  loadCampaignDetail,
  loadCampaignList,
  loadInsights,
  loadOverview,
  loadRecentPosts,
  parseCampaignFilter,
  parseCampaignSource,
} from './data.ts'
import { IMAGE_HOSTS } from './html.ts'
import {
  renderCampaignDetail,
  renderCampaignList,
  renderError,
  renderNotFound,
  renderOverview,
  renderPosts,
} from './pages.ts'
import { defaultDistDir, hasBuild, lookupStatic } from './static.ts'

export type DashboardLoaders = ApiLoaders

export type DashboardDeps = {
  password: string
  loaders: DashboardLoaders
  tz?: string
  now?: () => Date
  /** Directory of the built React app; null disables it (legacy pages only). Default: web/dist. */
  webDist?: string | null
}

const dbLoaders: DashboardLoaders = {
  overview: loadOverview,
  campaigns: loadCampaignList,
  campaign: loadCampaignDetail,
  posts: loadRecentPosts,
  insights: loadInsights,
}

const IMG_HOSTS = IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')

/** CSP of the server-rendered pages (inline styles and scripts). */
export const LEGACY_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: ${IMG_HOSTS}; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
/** CSP of the React app: same-origin scripts only. */
export const APP_CSP = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${IMG_HOSTS}; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

const SECURITY_HEADERS = {
  'Content-Security-Policy': LEGACY_CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/** Constant-time password check: both sides are hashed first so the buffers have equal length. */
export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected))
}

/** True when the Authorization header carries HTTP Basic credentials with the right password. */
export function isAuthorized(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return false
  return passwordMatches(decoded.slice(colon + 1), password)
}

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  send(
    req,
    res,
    status,
    JSON.stringify(body),
    { 'Content-Security-Policy': API_CSP, ...extra },
    'application/json; charset=utf-8',
  )
}

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  extra: Record<string, string> = {},
  type = 'text/html; charset=utf-8',
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

export function createRequestHandler(deps: DashboardDeps) {
  const tz = deps.tz ?? config.TZ_NAME
  const nowFn = deps.now ?? (() => new Date())
  const distDir = deps.webDist === undefined ? defaultDistDir() : deps.webDist

  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://dashboard.local')
    } catch {
      send(req, res, 400, 'Bad Request', {}, 'text/plain; charset=utf-8')
      return
    }
    const path = url.pathname
    const isApi = path === '/api' || path.startsWith('/api/')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (isApi) {
        sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' })
      } else {
        send(
          req,
          res,
          405,
          'Method Not Allowed',
          { Allow: 'GET, HEAD' },
          'text/plain; charset=utf-8',
        )
      }
      return
    }

    if (path === '/healthz') {
      send(req, res, 200, 'ok', {}, 'text/plain; charset=utf-8')
      return
    }
    if (!isAuthorized(req.headers.authorization, deps.password)) {
      send(
        req,
        res,
        401,
        'Unauthorized',
        { 'WWW-Authenticate': 'Basic realm="content-autopilot"' },
        'text/plain; charset=utf-8',
      )
      return
    }

    const ctx = { now: nowFn(), tz }
    if (isApi) {
      try {
        const result = await handleApi(path, url.searchParams, deps.loaders, ctx.now)
        sendJson(req, res, result.status, result.body)
      } catch (err) {
        console.error('dashboard api request failed:', err)
        sendJson(req, res, 500, { error: 'internal error' })
      }
      return
    }
    try {
      if (distDir && (await hasBuild(distDir))) {
        const file = await lookupStatic(distDir, path)
        if (file === 'bad') send(req, res, 400, 'Bad Request', {}, 'text/plain; charset=utf-8')
        else if (!file) send(req, res, 404, 'Not Found', {}, 'text/plain; charset=utf-8')
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
        return
      }
      if (path === '/') {
        send(req, res, 200, renderOverview(await deps.loaders.overview(), ctx))
        return
      }
      if (path === '/campaigns') {
        const filter = parseCampaignFilter(url.searchParams.get('status'))
        const source = parseCampaignSource(url.searchParams.get('source'))
        const rows = await deps.loaders.campaigns(filter, source)
        send(req, res, 200, renderCampaignList(rows, filter, ctx, source))
        return
      }
      const detail = /^\/campaigns\/(\d{1,15})$/.exec(path)
      if (detail) {
        const data = await deps.loaders.campaign(Number(detail[1]))
        if (!data) send(req, res, 404, renderNotFound())
        else send(req, res, 200, renderCampaignDetail(data, ctx))
        return
      }
      if (path === '/posts') {
        send(req, res, 200, renderPosts(await deps.loaders.posts(50), ctx))
        return
      }
      send(req, res, 404, renderNotFound())
    } catch (err) {
      console.error('dashboard request failed:', err)
      send(req, res, 500, renderError())
    }
  }
}

export function createDashboardServer(deps: DashboardDeps): http.Server {
  const handler = createRequestHandler(deps)
  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('dashboard handler crashed:', err)
      if (!res.headersSent) send(req, res, 500, 'Internal Server Error', {}, 'text/plain')
      else res.end()
    })
  })
}

/** Starts the read-only dashboard, or returns null (and says why) when no password is set. */
export async function startDashboard(): Promise<{ close(): Promise<void> } | null> {
  const password = config.DASHBOARD_PASSWORD
  if (!password) {
    console.log('dashboard disabled: DASHBOARD_PASSWORD is not set')
    return null
  }
  const server = createDashboardServer({ password, loaders: dbLoaders })
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
