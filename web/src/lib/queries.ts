import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'

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
