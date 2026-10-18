/**
 * Callback data for campaign buttons: `<ns>:<action>:<campaignId>:<revision>[:<arg>]`, e.g.
 * `camp:applied:12:3` or `camp:passr:12:3:brand`. The revision binds a button to the card it was
 * created for, like review_revision for posts. Buttons whose effect is gated by status alone
 * (result buttons, starting a draft) use revision 0. Stays far below Telegram's 64-byte limit.
 *
 * - camp (src/campaigns/telegram.ts): applied (the owner applied on the phone), pass (open the
 *   reason picker), passr (arg = reject reason), passc (close the picker), sel / unsel (result)
 * - rev (src/campaigns/review-telegram.ts): draft (ask for a memo), regen, done (review posted)
 */
export const CAMPAIGN_ACTIONS = {
  camp: ['applied', 'pass', 'passr', 'passc', 'sel', 'unsel'],
  rev: ['draft', 'regen', 'done'],
} as const

export type CallbackNs = keyof typeof CAMPAIGN_ACTIONS
export type CampaignCallback<N extends CallbackNs = CallbackNs> = {
  ns: N
  action: (typeof CAMPAIGN_ACTIONS)[N][number]
  campaignId: number
  revision: number
  arg?: string
}

export function encodeCampaignCallback(cb: CampaignCallback): string {
  const base = `${cb.ns}:${cb.action}:${cb.campaignId}:${cb.revision}`
  return cb.arg ? `${base}:${cb.arg}` : base
}

export function parseCampaignCallback(data: string): CampaignCallback | null {
  const m = data.match(/^(camp|rev):([a-z]+):(\d+):(\d+)(?::([a-z]+))?$/)
  if (!m) return null
  const ns = m[1] as CallbackNs
  const action = m[2] as string
  if (!(CAMPAIGN_ACTIONS[ns] as readonly string[]).includes(action)) return null
  const cb = {
    ns,
    action,
    campaignId: Number(m[3]),
    revision: Number(m[4]),
  } as CampaignCallback
  if (m[5]) cb.arg = m[5]
  return cb
}
