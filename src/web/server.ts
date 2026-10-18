import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { CampaignSource } from '../campaigns/types.ts'
import { config } from '../config.ts'
import {
  type CampaignDetailData,
  type CampaignFilter,
  type CampaignListRow,
  loadCampaignDetail,
  loadCampaignList,
  loadOverview,
  loadRecentPosts,
  type OverviewData,
  type PostRow,
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

export type DashboardLoaders = {
  overview(): Promise<OverviewData>
  campaigns(filter: CampaignFilter, source?: CampaignSource | null): Promise<CampaignListRow[]>
  campaign(id: number): Promise<CampaignDetailData | null>
  posts(): Promise<PostRow[]>
}

export type DashboardDeps = {
  password: string
  loaders: DashboardLoaders
  tz?: string
  now?: () => Date
}

const dbLoaders: DashboardLoaders = {
  overview: loadOverview,
  campaigns: loadCampaignList,
  campaign: loadCampaignDetail,
  posts: () => loadRecentPosts(50),
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: ${IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')}; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: string,
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

  return async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' }, 'text/plain; charset=utf-8')
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://dashboard.local')
    } catch {
      send(req, res, 400, 'Bad Request', {}, 'text/plain; charset=utf-8')
      return
    }
    const path = url.pathname

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
    try {
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
        send(req, res, 200, renderPosts(await deps.loaders.posts(), ctx))
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
