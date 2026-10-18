import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { loadExpiringDrafts, markExpiryWarned } from '../../src/pipeline/maintenance.ts'
import { seedPost, seedTopic } from './helpers.ts'

const now = new Date()
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000)

async function draft(touchedHoursAgo: number, status = 'PENDING_REVIEW') {
  const id = await seedPost(await seedTopic({ url: null }), { status })
  await query('update posts set updated_at = $2 where id = $1', [id, hoursAgo(touchedHoursAgo)])
  return id
}

const ids = async () => (await loadExpiringDrafts(now)).map((d) => d.id)
const touched = async (id: number) =>
  (await query<{ updated_at: Date }>('select updated_at from posts where id = $1', [id]))[0]
    ?.updated_at

describe('expiry warning SQL', () => {
  it('loads only pending drafts in their last 24h, and marking leaves updated_at alone', async () => {
    const soon = await draft(30)
    const fresh = await draft(5)
    const approved = await draft(30, 'SCHEDULED')
    const before = await touched(soon)

    expect(await ids()).toEqual([soon])
    expect(await ids()).not.toContain(fresh)
    expect(await ids()).not.toContain(approved)

    await markExpiryWarned([soon], now)
    expect(await touched(soon)).toEqual(before)
    expect(await ids()).toEqual([]) // warned for this touch
  })

  it('loads a draft again after a later touch', async () => {
    const id = await draft(30)
    await markExpiryWarned([id], now)
    expect(await ids()).toEqual([])
    // touched again later than the warning, then aged back into the last 24h
    await query('update posts set updated_at = $2, expiry_warned_at = $3 where id = $1', [
      id,
      hoursAgo(26),
      hoursAgo(40),
    ])
    expect(await ids()).toEqual([id])
  })
})
