import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, setCsrfToken } from './api.ts'
import type {
  AuthSessionResponse,
  CampaignActionName,
  CampaignActionRequests,
  CampaignDetailResponse,
} from './types.ts'

export const REFRESH_MS = 60_000
/** How often a campaign is re-read while its review draft is being written. */
export const DRAFT_POLL_MS = 3_000
/** A draft request older than this is probably lost (the worker alerts Telegram on a final failure). */
export const DRAFT_SLOW_MS = 10 * 60_000

const live = { refetchInterval: REFRESH_MS, staleTime: 30_000 } as const

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: api.overview, ...live })

export const useCampaigns = (status: string, source: string | null) =>
  useQuery({
    queryKey: ['campaigns', status, source],
    queryFn: () => api.campaigns(status, source),
    ...live,
  })

/** A review draft was requested and has not been written yet (regen_seq ran ahead of draft_seq). */
export const isDraftPending = (c: CampaignDetailResponse['campaign']) =>
  (c.status === 'SELECTED' || c.status === 'DRAFT_REVIEW') && c.regen_seq > c.draft_seq

export const useCampaign = (id: number) =>
  useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.campaign(id),
    ...live,
    // While a draft is being written, look again every few seconds until it arrives.
    refetchInterval: (query) =>
      query.state.data && isDraftPending(query.state.data.campaign) ? DRAFT_POLL_MS : REFRESH_MS,
  })

/** Refetches everything an action can change: the campaign, the lists and the overview counts. */
function refreshCampaignData(client: QueryClient, id: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['campaign', id] }),
    client.invalidateQueries({ queryKey: ['campaigns'] }),
    client.invalidateQueries({ queryKey: ['overview'] }),
  ])
}

export type CampaignActionVars = {
  [K in CampaignActionName]: { name: K; body: CampaignActionRequests[K] }
}[CampaignActionName]

/**
 * Runs one campaign operation. A 409 means the page was outdated: the campaign is refetched and
 * the error (with the server's message) stays on the mutation for the panel to show.
 */
export function useCampaignAction(id: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (vars: CampaignActionVars) =>
      api.campaignAction(id, vars.name, vars.body as never),
    onSuccess: (res) => {
      if (res.detail) client.setQueryData(['campaign', id], res.detail)
      void refreshCampaignData(client, id)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void refreshCampaignData(client, id)
    },
  })
}

export const usePosts = () =>
  useQuery({ queryKey: ['posts'], queryFn: () => api.posts(50), ...live })

export const useInsights = (days: number) =>
  useQuery({ queryKey: ['insights', days], queryFn: () => api.insights(days), ...live })

export const SESSION_KEY = ['session'] as const

/** Who is logged in. Its CSRF token is handed to the API client for every POST. */
export const useSession = () =>
  useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const s = await api.session()
      setCsrfToken(s.authenticated ? s.csrf : null)
      return s
    },
    staleTime: Number.POSITIVE_INFINITY,
  })

/** Marks the session as gone and drops every cached response it fetched. */
export function endSession(client: QueryClient): void {
  setCsrfToken(null)
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] })
  client.setQueryData<AuthSessionResponse>(SESSION_KEY, { authenticated: false })
}
