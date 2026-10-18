// Routes found in the revu web bundle (www.revu.net/build/www.min.js, 2026-10). Pages need the
// owner's revu login, which only the Aside browser on the local PC has.
export const REVU_ORIGIN = 'https://www.revu.net'

export const revuCampaignUrl = (externalId: string) => `${REVU_ORIGIN}/campaign/${externalId}`

/** The owner's campaigns by stage: request = applied, accepted = selected. */
export type RevuMyPageStatus = 'request' | 'accepted' | 'posted' | 'complete'
export const revuMyCampaignsUrl = (status: RevuMyPageStatus) =>
  `${REVU_ORIGIN}/mypage/campaigns?status=${status}`
