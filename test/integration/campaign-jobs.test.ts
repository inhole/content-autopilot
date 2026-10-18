import { describe, expect, it } from 'vitest'
import { LOST_FETCH_MINUTES, lostDiscoveredIds } from '../../src/campaigns/jobs.ts'
import { query } from '../../src/db/pool.ts'
import { seedApplyCampaign } from './campaign-helpers-apply.ts'

const MIN = 60_000

describe('lostDiscoveredIds', () => {
  it('returns only DISCOVERED campaigns untouched for 30+ minutes', async () => {
    const now = new Date('2026-10-18T03:00:00Z')
    const stale = await seedApplyCampaign({ status: 'DISCOVERED' })
    const fresh = await seedApplyCampaign({ status: 'DISCOVERED' })
    const other = await seedApplyCampaign({ status: 'DETAILED' })
    const setAge = (id: number, minutes: number) =>
      query('update campaigns set updated_at = $2 where id = $1', [
        id,
        new Date(now.getTime() - minutes * MIN),
      ])
    await setAge(stale, LOST_FETCH_MINUTES + 1)
    await setAge(fresh, LOST_FETCH_MINUTES - 1)
    await setAge(other, 600)

    expect(await lostDiscoveredIds(now)).toEqual([stale])
  })
})
