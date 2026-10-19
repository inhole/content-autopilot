/** Maps statuses to Badge variants: colour is used only for meaning. */
export type BadgeTone =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'info'
  | 'muted'

const CAMPAIGN_TONES: Record<string, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  APPLIED: 'info',
  SELECTED: 'success',
  DRAFT_REVIEW: 'info',
  POSTED: 'success',
  NOT_SELECTED: 'muted',
  REJECTED: 'muted',
  EXPIRED: 'muted',
  SKIPPED: 'muted',
  SHORTLISTED: 'outline',
  COLLECTED: 'outline',
}

const POST_TONES: Record<string, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  APPROVED: 'info',
  SCHEDULED: 'info',
  PUBLISHING: 'info',
  PUBLISHED: 'success',
  FAILED: 'destructive',
  REJECTED: 'muted',
  EXPIRED: 'muted',
}

export const campaignTone = (status: string): BadgeTone => CAMPAIGN_TONES[status] ?? 'outline'
export const postTone = (status: string): BadgeTone => POST_TONES[status] ?? 'outline'

/** D-n tone: past is muted, today and the next 2 days stand out. */
export function deadlineTone(days: number): BadgeTone {
  if (days < 0) return 'muted'
  return days <= 2 ? 'warning' : 'outline'
}
