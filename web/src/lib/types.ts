// Types only: nothing from src/ is bundled (verbatimModuleSyntax + `import type`).
import type {
  AddTopicConflict,
  AddTopicRequest,
  AddTopicResponse,
  OpsJobName,
  OpsJobState,
  OpsProfileConflict,
  OpsProfileFields,
  OpsProfileInvalid,
  OpsProfileRequests,
  OpsProfileResponse,
  OpsResponse,
  OpsRunResponse,
  PostActionConflict,
  PostActionName,
  PostActionRequests,
  PostActionResponse,
  PostDetailResponse,
  PostRejectReason,
  PostStatus,
  QueuedResponse,
  RevivableResponse,
  AuthCodeResponse,
  AuthSessionResponse,
  CampaignActionConflict,
  CampaignActionName,
  CampaignActionRequests,
  CampaignActionResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
} from '../../../src/web/api-types.ts'

export type {
  AddTopicConflict,
  AddTopicRequest,
  AddTopicResponse,
  OpsJobName,
  OpsJobState,
  OpsProfileConflict,
  OpsProfileFields,
  OpsProfileInvalid,
  OpsProfileRequests,
  OpsProfileResponse,
  OpsResponse,
  OpsRunResponse,
  PostActionConflict,
  PostActionName,
  PostActionRequests,
  PostActionResponse,
  PostDetailResponse,
  PostRejectReason,
  PostStatus,
  QueuedResponse,
  RevivableResponse,
  AuthCodeResponse,
  AuthSessionResponse,
  CampaignActionConflict,
  CampaignActionName,
  CampaignActionRequests,
  CampaignActionResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
}

export type CampaignRow = CampaignListResponse['rows'][number]
export type PostItem = PostListResponse['rows'][number]
export type StatusFilter = CampaignListResponse['filter']['status']
export type PostDetail = PostDetailResponse['post']
export type PostPart = PostDetailResponse['parts'][number]
export type RevivableRow = RevivableResponse['rows'][number]
export type OpsJob = OpsResponse['jobs'][number]
export type OpsSettings = OpsResponse['settings']
export type OpsProfile = NonNullable<OpsResponse['profile']>
