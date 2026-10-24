import { type QueryClient, useQuery } from '@tanstack/react-query'
import { api, setCsrfToken } from './api.ts'
import type { AuthSessionResponse } from './types.ts'

export const REFRESH_MS = 60_000

const live = { refetchInterval: REFRESH_MS, staleTime: 30_000 } as const

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: api.overview, ...live })

export const useCampaigns = (status: string, source: string | null) =>
  useQuery({
    queryKey: ['campaigns', status, source],
    queryFn: () => api.campaigns(status, source),
    ...live,
  })

export const useCampaign = (id: number) =>
  useQuery({ queryKey: ['campaign', id], queryFn: () => api.campaign(id), ...live })

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
