import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CampaignProfile,
  loadCampaignProfile,
  loadProfileInEffect,
  resetCampaignProfile,
  saveCampaignProfile,
} from '../../src/campaigns/profile.ts'
import { query } from '../../src/db/pool.ts'
import { dbProfileEdit, loadProfileForOps } from '../../src/web/ops.ts'

const FILE = join(tmpdir(), `campaign-profile-${process.pid}.json`)
const base: CampaignProfile = {
  about: 'file about',
  interests: ['i'],
  preferKeywords: [],
  excludeKeywords: ['x'],
  excludeBrands: [],
  review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
}
const saved = (about: string): CampaignProfile => ({ ...base, about })

beforeEach(async () => {
  writeFileSync(FILE, JSON.stringify(base))
  await query('delete from campaign_profile')
})
afterEach(async () => {
  await query('delete from campaign_profile')
  vi.restoreAllMocks()
})

describe('campaign profile storage', () => {
  it('falls back to the file when there is no row', async () => {
    expect(await loadProfileInEffect(FILE)).toMatchObject({
      source: 'file',
      revision: 0,
      profile: { about: 'file about' },
    })
  })

  it('saves revision 0 as 1, then n as n + 1, and rejects stale revisions', async () => {
    expect(await saveCampaignProfile(saved('one'), 0)).toBe(1)
    expect(await saveCampaignProfile(saved('late'), 0)).toBeNull()
    expect(await saveCampaignProfile(saved('two'), 1)).toBe(2)
    expect(await saveCampaignProfile(saved('late'), 1)).toBeNull()
    expect(await saveCampaignProfile(saved('late'), 9)).toBeNull()
    expect(await loadProfileInEffect(FILE)).toMatchObject({
      source: 'db',
      revision: 2,
      profile: { about: 'two' },
    })
  })

  it('lets exactly one of several concurrent saves on the same revision win', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => saveCampaignProfile(saved(`w${n}`), 0)),
    )
    expect(results.filter((r) => r === 1)).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(4)
    await saveCampaignProfile(saved('base'), 1)
    const next = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => saveCampaignProfile(saved(`u${n}`), 2)),
    )
    expect(next.filter((r) => r === 3)).toHaveLength(1)
    expect(next.filter((r) => r === null)).toHaveLength(4)
  })

  it('loads the DB copy and reflects a second save without a restart', async () => {
    await saveCampaignProfile(saved('first'), 0)
    expect((await loadCampaignProfile(FILE)).about).toBe('first')
    await saveCampaignProfile(saved('second'), 1)
    expect((await loadCampaignProfile(FILE)).about).toBe('second')
  })

  it('applies defaults when reading a stored copy', async () => {
    await query(`insert into campaign_profile (profile, revision) values ($1::jsonb, 1)`, [
      JSON.stringify({ about: 'a', interests: [], excludeKeywords: [], review: { tone: 't' } }),
    ])
    expect((await loadCampaignProfile(FILE)).review).toMatchObject({ minChars: 100, maxChars: 500 })
  })

  it('falls back to the file, keeping the row revision, when the stored JSON is invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await query(`insert into campaign_profile (profile, revision) values ('{"nope":1}', 7)`)
    expect(await loadProfileInEffect(FILE)).toMatchObject({
      source: 'file',
      revision: 7,
      profile: { about: 'file about' },
    })
    expect(error).toHaveBeenCalled()
    // the page can save over the broken copy
    expect(await saveCampaignProfile(saved('fixed'), 7)).toBe(8)
    expect((await loadProfileInEffect(FILE)).source).toBe('db')
  })

  it('reset: stale revisions change nothing, the current one brings the file back', async () => {
    await saveCampaignProfile(saved('one'), 0)
    expect(await resetCampaignProfile(5)).toBe(false)
    expect((await loadProfileInEffect(FILE)).source).toBe('db')
    expect(await resetCampaignProfile(1)).toBe(true)
    expect(await loadProfileInEffect(FILE)).toMatchObject({ source: 'file', revision: 2 })
    expect(await resetCampaignProfile(1)).toBe(false)
  })

  it('a page that saw an older copy stays stale across a reset and a new save', async () => {
    await saveCampaignProfile(saved('one'), 0)
    // Another tab resets (1 -> 2) and saves again (2 -> 3); this tab still holds revision 1.
    expect(await resetCampaignProfile(1)).toBe(true)
    expect(await saveCampaignProfile(saved('newer'), 0)).toBeNull()
    expect(await saveCampaignProfile(saved('newer'), 2)).toBe(3)
    expect(await saveCampaignProfile(saved('old tab'), 1)).toBeNull()
    expect(await resetCampaignProfile(1)).toBe(false)
    expect(await loadProfileInEffect(FILE)).toMatchObject({
      source: 'db',
      revision: 3,
      profile: { about: 'newer' },
    })
  })

  it('reset with revision 0: ok while no row exists, stale once one was saved', async () => {
    expect(await resetCampaignProfile(0)).toBe(true)
    await saveCampaignProfile(saved('one'), 0)
    expect(await resetCampaignProfile(0)).toBe(false)
    expect((await loadProfileInEffect(FILE)).source).toBe('db')
  })

  it('ops edit returns the profile now in effect', async () => {
    const res = await dbProfileEdit.save(saved('edited'), 0)
    expect(res).toMatchObject({ ok: true, profile: { about: 'edited', source: 'db', revision: 1 } })
    expect(await dbProfileEdit.save(saved('late'), 0)).toBeNull()
    expect(await loadProfileForOps()).toMatchObject({ about: 'edited', revision: 1 })
    const back = await dbProfileEdit.reset(1)
    expect(back).toMatchObject({ ok: true, profile: { source: 'file', revision: 2 } })
    expect(await dbProfileEdit.reset(1)).toBeNull()
  })
})
