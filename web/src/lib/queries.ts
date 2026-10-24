import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, setCsrfToken } from './api.ts'
import type {
  AuthSessionResponse,
  CampaignActionName,
  CampaignActionRequests,
  CampaignDetailResponse,
  OpsJobName,
  OpsResponse,
  PostActionName,
  PostActionRequests,
  PostDetailResponse,
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

/** How often a post is re-read while a regeneration or revival is being written. */
export const POST_POLL_MS = 3_000
/** A queued regeneration/revival older than this is probably lost (the worker alerts Telegram). */
export const POST_SLOW_MS = 10 * 60_000

/**
 * A regeneration or revival was queued: the displayed state to compare against. The request is
 * done once the post's revision (regeneration) or status (revival) differs from it.
 */
export type PostWatch = {
  kind: 'regenerate' | 'revive'
  revision: number
  status: string
  since: number
}

export const startPostWatch = (
  kind: PostWatch['kind'],
  post: PostDetailResponse['post'],
  now = Date.now(),
): PostWatch => ({
  kind,
  revision: post.revision,
  status: post.status,
  since: now,
})

/** True while the queued request has not changed the post yet. */
export const isPostWatchPending = (watch: PostWatch | null, post: PostDetailResponse['post']) =>
  watch !== null && post.revision === watch.revision && post.status === watch.status

/** The request has been waiting longer than the worker is expected to need. */
export const isPostWatchSlow = (watch: PostWatch, now = Date.now()) =>
  now - watch.since > POST_SLOW_MS

/** One post; `watching` looks again every few seconds until the queued job has changed it. */
export const usePost = (id: number, watching = false) =>
  useQuery({
    queryKey: ['post', id],
    queryFn: () => api.post(id),
    ...live,
    refetchInterval: watching ? POST_POLL_MS : REFRESH_MS,
  })

/** The expired drafts; polled faster for a while after a judgement was requested. */
export const useRevivable = (pollUntil = 0) =>
  useQuery({
    queryKey: ['revivable'],
    queryFn: api.revivable,
    ...live,
    refetchInterval: () => (Date.now() < pollUntil ? 5_000 : REFRESH_MS),
  })

/** Everything a Threads operation can change. */
function refreshPostData(client: QueryClient, id?: number) {
  return Promise.all([
    id === undefined
      ? client.invalidateQueries({ queryKey: ['post'] })
      : client.invalidateQueries({ queryKey: ['post', id] }),
    client.invalidateQueries({ queryKey: ['posts'] }),
    client.invalidateQueries({ queryKey: ['revivable'] }),
    client.invalidateQueries({ queryKey: ['overview'] }),
  ])
}

export type PostActionVars = {
  [K in PostActionName]: { name: K; body: PostActionRequests[K] }
}[PostActionName]

/** Runs one Threads operation; a 409 refetches the post and leaves the server's message. */
export function usePostAction(id: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (vars: PostActionVars) => api.postAction(id, vars.name, vars.body as never),
    onSuccess: (res) => {
      if (res.detail) client.setQueryData(['post', id], res.detail)
      void refreshPostData(client, id)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void refreshPostData(client, id)
    },
  })
}

/** POST /api/posts/add: a manual topic from a URL. */
export function useAddTopic() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.addTopic,
    onSuccess: () => void refreshPostData(client),
  })
}

/** The two queued jobs: judge the expired drafts, build the weekly digest. */
export function useReviveCheck() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.reviveCheck,
    onSuccess: () => void refreshPostData(client),
  })
}

export function useDigest() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.digest,
    onSuccess: () => void refreshPostData(client),
  })
}

export const useInsights = (days: number) =>
  useQuery({ queryKey: ['insights', days], queryFn: () => api.insights(days), ...live })

/** How often the operations page is re-read while a job is queued or running. */
export const OPS_POLL_MS = 3_000
/** Fast polling stops after this long, however busy the queue still looks. */
export const OPS_POLL_MAX_MS = 5 * 60_000

export const isOpsBusy = (data: OpsResponse | undefined) => !!data?.jobs.some((j) => j.busy)

/** Jobs and settings; every 3 s while a job is busy (until `pollUntil`), else the usual refresh. */
export const useOps = (pollUntil = 0) =>
  useQuery({
    queryKey: ['ops'],
    queryFn: api.ops,
    ...live,
    refetchInterval: (query) =>
      isOpsBusy(query.state.data) && Date.now() < pollUntil ? OPS_POLL_MS : REFRESH_MS,
  })

/** Runs one job now; refetches the jobs and whatever lists the job feeds. */
export function useRunOps() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: OpsJobName) => api.runOps(name),
    onSuccess: (_res, name) => {
      const keys = ['ops', 'overview']
      if (name === 'threads-daily') keys.push('posts')
      else if (name !== 'collect-insights') keys.push('campaigns')
      for (const key of keys) void client.invalidateQueries({ queryKey: [key] })
    },
  })
}

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
