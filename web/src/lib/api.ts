import type {
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
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
  if (p === '/api/posts') return f.postsFixture
  if (p === '/api/insights') return f.insightsFixture(Number(url.searchParams.get('days') ?? 30))
  throw new ApiError('찾을 수 없어요', 404)
}

async function get<T>(path: string): Promise<T> {
  if (MOCK) return (await mockGet(path)) as T
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    let message = `요청에 실패했어요 (${res.status})`
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // keep the generic message
    }
    throw new ApiError(message, res.status)
  }
  return (await res.json()) as T
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
}
