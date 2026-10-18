import { join } from 'node:path'
import { type BrowserAgent, getBrowserAgent } from '../aside/client.ts'
import { query } from '../db/pool.ts'
import {
  APPLY_SCRIPT,
  type ApplyScriptResult,
  LIST_MY_CAMPAIGN_IDS_SCRIPT,
  type ListMyCampaignsResult,
  SCREENSHOT_SCRIPT,
} from './revu-scripts.ts'
import { type RevuMyPageStatus, revuCampaignUrl } from './revu-urls.ts'
import { loadCampaign } from './store.ts'
import { MAX_CLAIM_ATTEMPTS, STALE_CLAIM_MINUTES } from './types.ts'

/**
 * Applies to an APPROVED campaign on revu, mirroring publishPost: the row is the source of truth.
 *
 * - `retry` = back to APPROVED (the next sweep re-finds it); `failed` = APPLY_FAILED, the owner
 *   gets a retry button.
 * - `dry-run` (ASIDE_DRY_RUN=true) = nothing was submitted. The row goes to APPLY_FAILED with a
 *   clear last_error rather than back to APPROVED, which would loop every sweep. The owner can
 *   apply by hand, or press retry after turning dry-run off.
 */
export type ApplyOutcome = {
  kind: 'applied' | 'dry-run' | 'retry' | 'failed' | 'skipped'
  error?: string
  screenshotPath?: string | null
}

export const DRY_RUN_ERROR = '드라이런: 제출하지 않음'
export const LOGIN_REQUIRED_ERROR = '레뷰 로그인이 필요해요'
export const SCREENSHOT_DIR = join('data', 'campaign-screenshots')

/** Thrown when another worker has taken over this campaign's claim. */
export class LostApplyClaimError extends Error {
  constructor() {
    super('apply claim was taken over by another worker')
    this.name = 'LostApplyClaimError'
  }
}

class NotLoggedInError extends Error {
  constructor() {
    super(LOGIN_REQUIRED_ERROR)
    this.name = 'NotLoggedInError'
  }
}

/** Pure: where a claimed campaign goes after an attempt that did not end in APPLIED. */
export function decideAfterFailedAttempt(attempts: number): 'retry' | 'failed' {
  return attempts < MAX_CLAIM_ATTEMPTS ? 'retry' : 'failed'
}

/** Pure: the error text to store for a submit script that reported no submission. */
export function describeSubmitResult(result: ApplyScriptResult | null): string {
  if (!result) return '신청 스크립트가 결과를 돌려주지 않았어요'
  if (result.submitted) return '제출했지만 신청 목록에서 확인되지 않아요'
  return result.reason ? `신청하지 못했어요: ${result.reason}` : '신청하지 못했어요'
}

/** Ids of campaigns on one stage of the owner's revu page. Throws when logged out. */
export async function listMyCampaignIds(
  agent: BrowserAgent,
  status: RevuMyPageStatus,
): Promise<Set<string>> {
  const result = await agent.runScript<ListMyCampaignsResult>(LIST_MY_CAMPAIGN_IDS_SCRIPT(status))
  if (!result) throw new Error(`revu ${status} list: no result`)
  if (!result.loggedIn) throw new NotLoggedInError()
  return new Set(result.ids)
}

/** True when the campaign is already on the applied ('request') or selected ('accepted') list. */
async function isOnMyLists(agent: BrowserAgent, externalId: string): Promise<boolean> {
  if ((await listMyCampaignIds(agent, 'request')).has(externalId)) return true
  return (await listMyCampaignIds(agent, 'accepted')).has(externalId)
}

/** Campaigns the apply sweep should pick up: APPROVED plus APPLYING claims gone stale. */
export async function dueApplyIds(now = new Date()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from campaigns
     where status = 'APPROVED'
        or (status = 'APPLYING' and updated_at < $1::timestamptz - make_interval(mins => $2))
     order by id`,
    [now, STALE_CLAIM_MINUTES],
  )
  return rows.map((r) => r.id)
}

export async function applyCampaign(
  campaignId: number,
  agent: BrowserAgent = getBrowserAgent(),
  now = new Date(),
): Promise<ApplyOutcome> {
  const [claim] = await query<{ claim_seq: number; attempts: number }>(
    `update campaigns
     set status = 'APPLYING', attempts = attempts + 1, claim_seq = claim_seq + 1, updated_at = now()
     where id = $1
       and (status = 'APPROVED'
            or (status = 'APPLYING' and updated_at < $2::timestamptz - make_interval(mins => $3)))
     returning claim_seq, attempts`,
    [campaignId, now, STALE_CLAIM_MINUTES],
  )
  if (!claim) return { kind: 'skipped' }
  const token = claim.claim_seq

  /** Conditional write: only the current claim owner may change the row. */
  const ownedUpdate = async (set: string, params: unknown[] = []): Promise<boolean> => {
    const rows = await query(
      `update campaigns set ${set}, updated_at = now()
       where id = $1 and status = 'APPLYING' and claim_seq = $2 returning id`,
      [campaignId, token, ...params],
    )
    return rows.length > 0
  }

  const markApplied = async (): Promise<ApplyOutcome> => {
    const saved = await ownedUpdate("status = 'APPLIED', applied_at = $3, last_error = null", [now])
    return saved ? { kind: 'applied' } : { kind: 'skipped' }
  }

  const fail = async (error: string, immediate = false): Promise<ApplyOutcome> => {
    const verdict = immediate ? 'failed' : decideAfterFailedAttempt(claim.attempts)
    if (verdict === 'retry') {
      const saved = await ownedUpdate("status = 'APPROVED', last_error = $3", [error])
      return saved ? { kind: 'retry', error } : { kind: 'skipped' }
    }
    const screenshotPath = immediate ? null : await takeScreenshot(agent, campaignId, now)
    const saved = await ownedUpdate(
      "status = 'APPLY_FAILED', last_error = $3, screenshot_path = $4",
      [error, screenshotPath],
    )
    return saved ? { kind: 'failed', error, screenshotPath } : { kind: 'skipped' }
  }

  const campaign = await loadCampaign(campaignId)
  if (!campaign || campaign.apply_message === null || campaign.apply_message.trim() === '') {
    return fail('신청 메시지가 비어 있어요', true)
  }

  let submitted = false
  try {
    // A lost response from an earlier attempt may already have applied; look before submitting.
    if (await isOnMyLists(agent, campaign.external_id)) return await markApplied()

    // Right before the irreversible step; doubles as a heartbeat.
    if (!(await ownedUpdate('status = status'))) throw new LostApplyClaimError()

    // From here a failure may hide a submit that went through (lost response), so errors re-check.
    submitted = true
    const result = await agent.runScript<ApplyScriptResult>(
      APPLY_SCRIPT(campaign.external_id, campaign.apply_message),
      { sideEffect: true },
    )
    if (result === null && agent.dryRun) {
      const saved = await ownedUpdate("status = 'APPLY_FAILED', last_error = $3", [DRY_RUN_ERROR])
      return saved ? { kind: 'dry-run', error: DRY_RUN_ERROR } : { kind: 'skipped' }
    }

    // Never trust the script's own answer: the lists show whether revu took the application.
    if (await isOnMyLists(agent, campaign.external_id)) return await markApplied()
    return await fail(describeSubmitResult(result))
  } catch (err) {
    if (err instanceof LostApplyClaimError) return { kind: 'skipped' }
    if (err instanceof NotLoggedInError) return await fail(LOGIN_REQUIRED_ERROR, true)
    const error = (err as Error).message
    if (submitted) {
      // The submit ran; if only the verification failed, look once more before counting a failure.
      try {
        if (await isOnMyLists(agent, campaign.external_id)) return await markApplied()
      } catch {
        // unknown; the next attempt starts with the same list check
      }
    }
    return await fail(error)
  }
}

async function takeScreenshot(
  agent: BrowserAgent,
  campaignId: number,
  now: Date,
): Promise<string | null> {
  const campaign = await loadCampaign(campaignId)
  if (!campaign) return null
  const path = join(SCREENSHOT_DIR, `campaign-${campaignId}-${now.getTime()}.png`)
  try {
    const result = await agent.runScript<{ ok: boolean }>(
      SCREENSHOT_SCRIPT(revuCampaignUrl(campaign.external_id), path),
    )
    return result?.ok ? path : null
  } catch {
    return null
  }
}
