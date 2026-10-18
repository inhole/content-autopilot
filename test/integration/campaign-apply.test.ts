import { describe, expect, it } from 'vitest'
import { applyCampaign, dueApplyIds } from '../../src/campaigns/apply.ts'
import { MAX_CLAIM_ATTEMPTS } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'
import { FakeBrowserAgent } from '../fake-browser.ts'
import { getApplyCampaign, list, seedApplyCampaign } from './campaign-helpers-apply.ts'

const submits = (agent: FakeBrowserAgent) =>
  agent.calls.filter((c) => c.kind === 'script' && c.opts?.sideEffect)

describe('applyCampaign', () => {
  it('applies: checks the lists first, submits with sideEffect, verifies on the list', async () => {
    const id = await seedApplyCampaign({ externalId: '555' })
    const agent = new FakeBrowserAgent()
    // pre-check: request, accepted; submit; verify: request
    agent.scriptResults = [list([]), list([]), { submitted: true }, list(['555'])]
    const now = new Date('2026-10-18T03:00:00Z')

    expect(await applyCampaign(id, agent, now)).toEqual({ kind: 'applied' })
    const row = await getApplyCampaign(id)
    expect(row).toMatchObject({ status: 'APPLIED', attempts: 1, claim_seq: 1, last_error: null })
    expect(row.applied_at?.toISOString()).toBe(now.toISOString())
    expect(submits(agent)).toHaveLength(1)
    expect(submits(agent)[0]?.input).toContain('"https://www.revu.net/campaign/555"')
    expect(submits(agent)[0]?.input).toContain('안녕하세요, 신청합니다.')
  })

  it('skips a campaign that is not APPROVED', async () => {
    const agent = new FakeBrowserAgent()
    for (const status of ['PENDING_REVIEW', 'APPLIED', 'APPLY_FAILED'] as const) {
      const id = await seedApplyCampaign({ status })
      expect(await applyCampaign(id, agent)).toEqual({ kind: 'skipped' })
      expect((await getApplyCampaign(id)).status).toBe(status)
    }
    expect(agent.calls).toHaveLength(0)
  })

  it('reconciles a lost response: already on the request list means applied, no resubmit', async () => {
    const id = await seedApplyCampaign({ externalId: '77' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list(['77'])]
    expect(await applyCampaign(id, agent)).toEqual({ kind: 'applied' })
    expect(submits(agent)).toHaveLength(0)
    expect((await getApplyCampaign(id)).status).toBe('APPLIED')
  })

  it('also counts the accepted list as applied', async () => {
    const id = await seedApplyCampaign({ externalId: '78' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list([]), list(['78'])]
    expect(await applyCampaign(id, agent)).toEqual({ kind: 'applied' })
    expect(submits(agent)).toHaveLength(0)
  })

  it('fails at once when revu is logged out, without retrying', async () => {
    const id = await seedApplyCampaign()
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list([], false)]
    expect(await applyCampaign(id, agent)).toMatchObject({
      kind: 'failed',
      error: '레뷰 로그인이 필요해요',
    })
    expect(await getApplyCampaign(id)).toMatchObject({
      status: 'APPLY_FAILED',
      last_error: '레뷰 로그인이 필요해요',
    })
    expect(submits(agent)).toHaveLength(0)
  })

  it('fails at once without an apply message', async () => {
    const id = await seedApplyCampaign({ applyMessage: null })
    const agent = new FakeBrowserAgent()
    expect(await applyCampaign(id, agent)).toMatchObject({ kind: 'failed' })
    expect((await getApplyCampaign(id)).status).toBe('APPLY_FAILED')
    expect(agent.calls).toHaveLength(0)
  })

  it('dry-run submits nothing and parks the row in APPLY_FAILED', async () => {
    const id = await seedApplyCampaign()
    const agent = new FakeBrowserAgent(true)
    agent.scriptResults = [list([]), list([])]
    expect(await applyCampaign(id, agent)).toEqual({
      kind: 'dry-run',
      error: '드라이런: 제출하지 않음',
    })
    expect(await getApplyCampaign(id)).toMatchObject({
      status: 'APPLY_FAILED',
      last_error: '드라이런: 제출하지 않음',
    })
    expect(await dueApplyIds()).toEqual([])
  })

  it('goes back to APPROVED when the submit did not take, until attempts run out', async () => {
    const id = await seedApplyCampaign({ externalId: '9' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [
      list([]),
      list([]),
      { submitted: false, reason: '신청 버튼을 찾지 못했어요' },
      list([]),
      list([]),
    ]
    const first = await applyCampaign(id, agent)
    expect(first).toMatchObject({ kind: 'retry' })
    expect(first.error).toContain('신청 버튼을 찾지 못했어요')
    expect(await getApplyCampaign(id)).toMatchObject({ status: 'APPROVED', attempts: 1 })

    await query('update campaigns set attempts = $2 where id = $1', [id, MAX_CLAIM_ATTEMPTS - 1])
    agent.scriptResults = [
      list([]),
      list([]),
      { submitted: false, reason: 'x' },
      list([]),
      list([]),
      { ok: true },
    ]
    const last = await applyCampaign(id, agent)
    expect(last).toMatchObject({ kind: 'failed' })
    expect(last.screenshotPath).toContain(`campaign-${id}-`)
    const row = await getApplyCampaign(id)
    expect(row).toMatchObject({ status: 'APPLY_FAILED', attempts: MAX_CLAIM_ATTEMPTS })
    expect(row.screenshot_path).toBe(last.screenshotPath)
  })

  it('treats a script error after a lost response as applied when the list shows it', async () => {
    const id = await seedApplyCampaign({ externalId: '31' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [
      list([]),
      list([]),
      new Error('aside repl failed (timeout)'),
      list(['31']),
    ]
    expect(await applyCampaign(id, agent)).toEqual({ kind: 'applied' })
    expect((await getApplyCampaign(id)).status).toBe('APPLIED')
  })

  it('retries after a script error when the list does not show it', async () => {
    const id = await seedApplyCampaign({ externalId: '32' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list([]), list([]), new Error('aside repl failed'), list([]), list([])]
    expect(await applyCampaign(id, agent)).toMatchObject({
      kind: 'retry',
      error: 'aside repl failed',
    })
    expect((await getApplyCampaign(id)).status).toBe('APPROVED')
  })
})

describe('apply claims', () => {
  it('does not take a fresh APPLYING claim but reclaims a stale one', async () => {
    const id = await seedApplyCampaign({ status: 'APPLYING', externalId: '40' })
    const agent = new FakeBrowserAgent()
    expect(await applyCampaign(id, agent)).toEqual({ kind: 'skipped' })
    expect(await dueApplyIds()).toEqual([])

    await query("update campaigns set updated_at = now() - interval '11 minutes' where id = $1", [
      id,
    ])
    expect(await dueApplyIds()).toEqual([id])
    agent.scriptResults = [list(['40'])]
    expect(await applyCampaign(id, agent)).toEqual({ kind: 'applied' })
    expect(await getApplyCampaign(id)).toMatchObject({ status: 'APPLIED', claim_seq: 1 })
  })

  it('a worker that lost its claim writes nothing and never submits', async () => {
    const id = await seedApplyCampaign({ externalId: '41' })
    const agent = new FakeBrowserAgent()
    // While the first worker reads the lists, another worker takes over the claim.
    let reads = 0
    const realRun = agent.runScript.bind(agent)
    agent.runScript = async <T>(body: string, opts?: Parameters<typeof realRun>[1]) => {
      const result = await realRun<T>(body, opts)
      if (++reads === 2) {
        await query(
          'update campaigns set claim_seq = claim_seq + 1, attempts = attempts + 1 where id = $1',
          [id],
        )
      }
      return result
    }
    agent.scriptResults = [list([]), list([]), { submitted: true }]

    expect(await applyCampaign(id, agent)).toEqual({ kind: 'skipped' })
    expect(submits(agent)).toHaveLength(0)
    expect(await getApplyCampaign(id)).toMatchObject({ status: 'APPLYING', claim_seq: 2 })
  })

  it('dueApplyIds lists APPROVED rows only (and stale APPLYING)', async () => {
    const a = await seedApplyCampaign()
    await seedApplyCampaign({ status: 'APPLIED' })
    await seedApplyCampaign({ status: 'APPLY_FAILED' })
    const b = await seedApplyCampaign({ status: 'APPLYING' })
    await query("update campaigns set updated_at = now() - interval '1 hour' where id = $1", [b])
    await seedApplyCampaign({ status: 'APPLYING' })
    expect(await dueApplyIds()).toEqual([a, b])
  })
})
