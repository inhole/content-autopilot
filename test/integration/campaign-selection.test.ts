import { describe, expect, it } from 'vitest'
import { runCampaignReminders } from '../../src/campaigns/reminders.ts'
import { checkSelections } from '../../src/campaigns/selection.ts'
import { query } from '../../src/db/pool.ts'
import { FakeBrowserAgent } from '../fake-browser.ts'
import { getApplyCampaign, list, seedApplyCampaign } from './campaign-helpers-apply.ts'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-10-18T03:00:00Z')

describe('checkSelections', () => {
  it('moves APPLIED campaigns found on the accepted list to SELECTED', async () => {
    const id = await seedApplyCampaign({ status: 'APPLIED', externalId: '501' })
    const other = await seedApplyCampaign({ status: 'APPLIED', externalId: '502' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list(['501'])]
    expect(await checkSelections(agent, now)).toEqual({ selected: [id], notSelected: [] })
    const row = await getApplyCampaign(id)
    expect(row.status).toBe('SELECTED')
    expect(row.selected_at?.toISOString()).toBe(now.toISOString())
    expect((await getApplyCampaign(other)).status).toBe('APPLIED')
  })

  it('marks NOT_SELECTED only once the announcement is more than 2 days past', async () => {
    const lost = await seedApplyCampaign({
      status: 'APPLIED',
      announceAt: new Date(now.getTime() - 2 * DAY - 60_000),
    })
    const recent = await seedApplyCampaign({
      status: 'APPLIED',
      announceAt: new Date(now.getTime() - DAY),
    })
    const unknown = await seedApplyCampaign({ status: 'APPLIED', announceAt: null })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list([])]
    expect(await checkSelections(agent, now)).toEqual({ selected: [], notSelected: [lost] })
    expect((await getApplyCampaign(recent)).status).toBe('APPLIED')
    expect((await getApplyCampaign(unknown)).status).toBe('APPLIED')
  })

  it('throws when logged out and changes nothing', async () => {
    const id = await seedApplyCampaign({
      status: 'APPLIED',
      announceAt: new Date(now.getTime() - 5 * DAY),
    })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list([], false)]
    await expect(checkSelections(agent, now)).rejects.toThrow('레뷰 로그인이 필요해요')
    expect((await getApplyCampaign(id)).status).toBe('APPLIED')
  })

  it('leaves campaigns in other statuses alone', async () => {
    const id = await seedApplyCampaign({ status: 'POSTED', externalId: '600' })
    const agent = new FakeBrowserAgent()
    agent.scriptResults = [list(['600'])]
    expect(await checkSelections(agent, now)).toEqual({ selected: [], notSelected: [] })
    expect((await getApplyCampaign(id)).status).toBe('POSTED')
  })
})

describe('runCampaignReminders', () => {
  const tz = 'Asia/Seoul'

  async function seedSelected() {
    return seedApplyCampaign({
      status: 'SELECTED',
      selectedAt: new Date(now.getTime() - 4 * DAY),
      reviewDeadline: new Date('2026-10-19T14:00:00Z'),
    })
  }

  it('sends each reminder once', async () => {
    const id = await seedSelected()
    const sent: string[] = []
    const send = async (text: string) => {
      sent.push(text)
    }
    // selected + received-check (4 days since selection) + review-d1 (deadline 10-19 23:00 KST)
    expect(await runCampaignReminders(send, now, tz)).toBe(3)
    expect(sent).toHaveLength(3)
    const rows = await query<{ kind: string }>(
      'select kind from campaign_reminders where campaign_id = $1 order by kind',
      [id],
    )
    expect(rows.map((r) => r.kind)).toEqual(['received-check', 'review-d1', 'selected'])
    expect(await runCampaignReminders(send, now, tz)).toBe(0)
    expect(sent).toHaveLength(3)
  })

  it('deletes the row when the send fails so the next run retries, and continues', async () => {
    const id = await seedSelected()
    const sent: string[] = []
    let failFirst = true
    const send = async (text: string) => {
      if (failFirst) {
        failFirst = false
        throw new Error('telegram down')
      }
      sent.push(text)
    }
    expect(await runCampaignReminders(send, now, tz)).toBe(2)
    const left = await query<{ kind: string }>(
      'select kind from campaign_reminders where campaign_id = $1',
      [id],
    )
    expect(left).toHaveLength(2)

    expect(await runCampaignReminders(send, now, tz)).toBe(1)
    expect(sent).toHaveLength(3)
    expect(await runCampaignReminders(send, now, tz)).toBe(0)
  })
})
