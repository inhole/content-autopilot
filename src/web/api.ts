import { type CampaignSource, competition, sourceInfo } from '../campaigns/types.ts'
import type { ApiError, OpsResponse } from './api-types.ts'
import {
  type CampaignDetailData,
  type CampaignFilter,
  type CampaignListRow,
  type InsightsData,
  nextDeadline,
  type OverviewData,
  type PostDetailData,
  type PostOrigin,
  type PostRow,
  parseCampaignFilter,
  parseCampaignSource,
  parseInsightsDays,
  parsePostLimit,
  type RevivableData,
} from './data.ts'

/** Data access of the JSON API; the server wires the DB loaders, tests pass fakes. */
export type ApiLoaders = {
  overview(): Promise<OverviewData>
  campaigns(filter: CampaignFilter, source?: CampaignSource | null): Promise<CampaignListRow[]>
  campaign(id: number): Promise<CampaignDetailData | null>
  posts(limit: number): Promise<(PostRow & { origin: PostOrigin })[]>
  insights(days: number, now: Date): Promise<InsightsData>
  post(id: number): Promise<PostDetailData | null>
  revivable(): Promise<RevivableData>
  ops(): Promise<OpsResponse>
}

export type ApiResult = { status: number; body: unknown }

export const apiError = (status: number, message: string): ApiResult => ({
  status,
  body: { error: message } satisfies ApiError,
})

/**
 * Handles a GET `/api/*` request. Dates inside the body become ISO strings when the server runs
 * JSON.stringify. Unexpected loader errors propagate to the server (500 without details).
 */
export async function handleApi(
  path: string,
  params: URLSearchParams,
  loaders: ApiLoaders,
  now: Date,
): Promise<ApiResult> {
  if (path === '/api/overview') return { status: 200, body: await loaders.overview() }

  if (path === '/api/campaigns') {
    const status = parseCampaignFilter(params.get('status'))
    const source = parseCampaignSource(params.get('source'))
    const rows = await loaders.campaigns(status, source)
    return {
      status: 200,
      body: {
        filter: { status, source },
        rows: rows.map((r) => {
          const next = nextDeadline(r)
          return {
            ...r,
            next_deadline: next
              ? {
                  at: next.at,
                  kind: next.kind,
                  estimated: next.kind === 'apply' && sourceInfo(r.source).estimatedDeadline,
                }
              : null,
            competition: competition(r),
          }
        }),
      },
    }
  }

  const detail = /^\/api\/campaigns\/([^/]+)$/.exec(path)
  if (detail) {
    const idText = detail[1] as string
    if (!/^\d{1,15}$/.test(idText)) return apiError(404, 'not found')
    const data = await loaders.campaign(Number(idText))
    return data ? { status: 200, body: data } : apiError(404, 'not found')
  }

  const postDetail = /^\/api\/posts\/([^/]+)$/.exec(path)
  if (postDetail) {
    const idText = postDetail[1] as string
    if (!/^\d{1,15}$/.test(idText)) return apiError(404, 'not found')
    const data = await loaders.post(Number(idText))
    return data ? { status: 200, body: data } : apiError(404, 'not found')
  }

  if (path === '/api/ops') return { status: 200, body: await loaders.ops() }

  if (path === '/api/revivable') return { status: 200, body: await loaders.revivable() }

  if (path === '/api/posts') {
    const rows = await loaders.posts(parsePostLimit(params.get('limit')))
    return { status: 200, body: { rows } }
  }

  if (path === '/api/insights') {
    return { status: 200, body: await loaders.insights(parseInsightsDays(params.get('days')), now) }
  }

  return apiError(404, 'not found')
}
