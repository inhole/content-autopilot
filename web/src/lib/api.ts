import type {
  AddTopicRequest,
  AddTopicResponse,
  AuthCodeResponse,
  AuthSessionResponse,
  CampaignActionName,
  CampaignActionRequests,
  CampaignActionResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OpsJobName,
  OpsResponse,
  OpsRunResponse,
  OverviewResponse,
  PostActionName,
  PostActionRequests,
  PostActionResponse,
  PostDetailResponse,
  PostListResponse,
  QueuedResponse,
  RevivableResponse,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  /** Seconds until a rate-limited request may be retried (429 only). */
  readonly retryAfter: number | null
  /** Extra fields of the error body (e.g. `postId` of an already covered article). */
  readonly body: Record<string, unknown>
  constructor(
    message: string,
    status: number,
    retryAfter: number | null = null,
    body: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfter = retryAfter
    this.body = body
  }
}

// The session's CSRF token (from /api/auth/session or the login response), sent with every POST.
let csrfToken: string | null = null
export const setCsrfToken = (token: string | null) => {
  csrfToken = token
}

const MOCK = import.meta.env.MODE === 'mock' || import.meta.env.VITE_MOCK === '1'

async function mockGet(path: string): Promise<unknown> {
  // Dynamic import: the fixtures are dropped from production bundles (MOCK is a build-time constant).
  const f = await import('../mocks/fixtures.ts')
  const url = new URL(path, 'http://mock')
  const p = url.pathname
  if (p === '/api/overview') return f.overviewFixture
  if (p === '/api/campaigns')
    return f.campaignListFixture(
      url.searchParams.get('status') ?? 'active',
      url.searchParams.get('source'),
    )
  const m = p.match(/^\/api\/campaigns\/(\d+)$/)
  if (m) {
    const d = f.campaignDetailFixture(Number(m[1]))
    if (!d) throw new ApiError('찾을 수 없어요', 404)
    return d
  }
  if (p === '/api/posts') return f.mockPostsList()
  if (p === '/api/revivable') return f.mockRevivable()
  const pm = p.match(/^\/api\/posts\/(\d+)$/)
  if (pm) {
    const d = f.mockPostDetail(Number(pm[1]))
    if (!d) throw new ApiError('찾을 수 없어요', 404)
    return d
  }
  if (p === '/api/insights') return f.insightsFixture(Number(url.searchParams.get('days') ?? 30))
  if (p === '/api/ops') return f.mockOps()
  if (p === '/api/auth/session') return f.sessionFixture
  throw new ApiError('찾을 수 없어요', 404)
}

async function mockPost(path: string, body: unknown): Promise<unknown> {
  const f = await import('../mocks/fixtures.ts')
  const action = path.match(/^\/api\/campaigns\/(\d+)\/([a-z]+)$/)
  if (action) {
    const result = f.mockCampaignAction(Number(action[1]), action[2] as string, body)
    if (result === 'stale')
      throw new ApiError('이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요', 409)
    if (result === 'not_found') throw new ApiError('찾을 수 없어요', 404)
    return { ok: true, telegramSynced: true, detail: result }
  }
  const postAction = path.match(/^\/api\/posts\/(\d+)\/([a-zA-Z]+)$/)
  if (postAction) {
    const result = f.mockPostAction(Number(postAction[1]), postAction[2] as string, body)
    if (result === 'stale')
      throw new ApiError('이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요', 409)
    if (result === 'not_found') throw new ApiError('찾을 수 없어요', 404)
    return { ok: true, telegramSynced: true, detail: result }
  }
  if (path === '/api/posts/add') {
    const result = f.mockAddTopic(body as AddTopicRequest)
    if ('postId' in result)
      throw new ApiError('이미 다룬 기사예요', 409, null, { postId: result.postId })
    return result
  }
  const ops = path.match(/^\/api\/ops\/([a-z-]+)\/run$/)
  if (ops) {
    const result = f.mockRunOps(ops[1] as string)
    if (result === 'not_found') throw new ApiError('알 수 없는 작업이에요', 404)
    return result
  }
  if (path === '/api/revivable/check') return f.mockReviveCheck()
  if (path === '/api/digest') return { ok: true }
  if (path === '/api/auth/code') return { expiresAt: new Date(Date.now() + 300_000).toISOString() }
  if (path === '/api/auth/login') return f.sessionFixture
  return { ok: true, revoked: 1 }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `요청에 실패했어요 (${res.status})`
    let retryAfter: number | null = null
    let extra: Record<string, unknown> = {}
    try {
      const body = (await res.json()) as { error?: unknown; retryAfter?: unknown }
      if (typeof body.error === 'string') message = body.error
      if (typeof body.retryAfter === 'number') retryAfter = body.retryAfter
      extra = body as Record<string, unknown>
    } catch {
      // keep the generic message
    }
    throw new ApiError(message, res.status, retryAfter, extra)
  }
  return (await res.json()) as T
}

async function get<T>(path: string): Promise<T> {
  if (MOCK) return (await mockGet(path)) as T
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  return parse<T>(res)
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  if (MOCK) return (await mockPost(path, body)) as T
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify(body),
  })
  return parse<T>(res)
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  overview: () => get<OverviewResponse>('/api/overview'),
  campaigns: (status: string, source: string | null) =>
    get<CampaignListResponse>(`/api/campaigns${qs({ status, source })}`),
  campaign: (id: number) => get<CampaignDetailResponse>(`/api/campaigns/${id}`),
  posts: (limit = 50) => get<PostListResponse>(`/api/posts${qs({ limit })}`),
  insights: (days: number) => get<InsightsResponse>(`/api/insights${qs({ days })}`),
  post: (id: number) => get<PostDetailResponse>(`/api/posts/${id}`),
  revivable: () => get<RevivableResponse>('/api/revivable'),
  postAction: <K extends PostActionName>(id: number, name: K, body: PostActionRequests[K]) =>
    post<PostActionResponse>(`/api/posts/${id}/${name}`, body),
  addTopic: (body: AddTopicRequest) => post<AddTopicResponse>('/api/posts/add', body),
  reviveCheck: () => post<QueuedResponse>('/api/revivable/check'),
  digest: () => post<QueuedResponse>('/api/digest'),
  campaignAction: <K extends CampaignActionName>(
    id: number,
    name: K,
    body: CampaignActionRequests[K],
  ) => post<CampaignActionResponse>(`/api/campaigns/${id}/${name}`, body),
  ops: () => get<OpsResponse>('/api/ops'),
  runOps: (name: OpsJobName) => post<OpsRunResponse>(`/api/ops/${name}/run`, {}),
  session: () => get<AuthSessionResponse>('/api/auth/session'),
  requestCode: () => post<AuthCodeResponse>('/api/auth/code'),
  login: (code: string) => post<AuthSessionResponse>('/api/auth/login', { code }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  logoutAll: () => post<{ ok: true; revoked: number }>('/api/auth/logout-all'),
}
