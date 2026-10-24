// Types only: nothing from src/ is bundled (verbatimModuleSyntax + `import type`).
import type {
  AuthCodeResponse,
  AuthSessionResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
} from '../../../src/web/api-types.ts'

export type {
  AuthCodeResponse,
  AuthSessionResponse,
  CampaignDetailResponse,
  CampaignListResponse,
  InsightsResponse,
  OverviewResponse,
  PostListResponse,
}

export type CampaignRow = CampaignListResponse['rows'][number]
export type PostItem = PostListResponse['rows'][number]
export type StatusFilter = CampaignListResponse['filter']['status']
