import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

// A fixed profile, so the quota case does not depend on config/campaign-profile.json.
vi.mock('../../src/campaigns/profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/campaigns/profile.ts')>()
  const profile = actual.parseCampaignProfile({
    about: 'test',
    interests: [],
    excludeKeywords: [],
    review: { tone: 'plain' },
  })
  return { ...actual, loadCampaignProfile: async () => profile }
})

const { config } = await import('../../src/config.ts')
const { query } = await import('../../src/db/pool.ts')
const { CQ } = await import('../../src/campaigns/jobs.ts')
const { rankCollected: rankCampaigns } = await import('../../src/campaigns/rank.ts')
const { createBoss, Q } = await import('../../src/jobs.ts')
const { approvePost } = await import('../../src/pipeline/publish.ts')
const { rankCollected } = await import('../../src/pipeline/rank.ts')
const { applySchedules } = await import('../../src/schedules.ts')
const { dailyToCron, loadRuntimeSettings, resetRuntimeSettings, saveRuntimeSettings } =
  await import('../../src/settings.ts')
const { createScheduleEdit, loadOps } = await import('../../src/web/ops.ts')
const { getCampaign, seedCampaign } = await import('./campaign-helpers-rank.ts')
const { getPost, seedPost, seedTopic } = await import('./helpers.ts')

type Fields = Parameters<typeof saveRuntimeSettings>[0]
const daily = (minute: number, hours: number[]) => ({ minute, hours })
const fields = (patch: Partial<Fields> = {}): Fields => ({
  threadsCollect: daily(0, [5]),
  giftCollect: daily(10, [8, 14]),
  musinsaCollect: daily(20, [9]),
  dailyPostCount: 2,
  publishSlots: ['07:30', '13:00'],
  campaignDailyMax: 1,
  ...patch,
})

const TARGETS = {
  threadsCollect: Q.daily,
  giftCollect: CQ.collect,
  musinsaCollect: CQ.musinsaCollect,
}
let boss: PgBoss
const cronOf = async (queue: string) => (await boss.getSchedules(queue))[0]?.cron

beforeAll(async () => {
  boss = createBoss()
  await boss.start()
  // Same options as ops.test.ts: createQueue keeps the first config, so both files must agree.
  await boss.createQueue(Q.daily, { policy: 'singleton', retryLimit: 0 })
  for (const q of [CQ.collect, CQ.musinsaCollect]) {
    await boss.createQueue(q, { policy: 'stately', retryLimit: 0 })
  }
})
afterAll(async () => {
  for (const q of Object.values(TARGETS)) await boss.unschedule(q)
  await boss.stop({ graceful: false })
})
beforeEach(async () => {
  await query('delete from runtime_settings')
  chatJson.mockReset()
})
afterEach(async () => {
  await query('delete from runtime_settings')
})

describe('runtime settings storage', () => {
  it('falls back to env when there is no row', async () => {
    const s = await loadRuntimeSettings()
    expect(s).toMatchObject({
      source: 'env',
      revision: 0,
      dailyPostCount: config.DAILY_POST_COUNT,
      publishSlots: config.PUBLISH_SLOTS,
      campaignDailyMax: config.CAMPAIGN_DAILY_MAX,
      crons: {
        threadsCollect: config.COLLECT_CRON,
        giftCollect: config.GIFT_COLLECT_CRON,
        musinsaCollect: config.MUSINSA_COLLECT_CRON,
      },
    })
  })

  it('saves revision 0 as 1, then n as n + 1, and rejects stale revisions', async () => {
    expect(await saveRuntimeSettings(fields(), 0)).toBe(1)
    expect(await saveRuntimeSettings(fields(), 0)).toBeNull()
    expect(await saveRuntimeSettings(fields({ dailyPostCount: 4 }), 1)).toBe(2)
    expect(await saveRuntimeSettings(fields(), 1)).toBeNull()
    expect(await saveRuntimeSettings(fields(), 9)).toBeNull()
    expect(await loadRuntimeSettings()).toMatchObject({
      source: 'db',
      revision: 2,
      dailyPostCount: 4,
      publishSlots: ['07:30', '13:00'],
      campaignDailyMax: 1,
      crons: {
        threadsCollect: '0 5 * * *',
        giftCollect: '10 8,14 * * *',
        musinsaCollect: '20 9 * * *',
      },
    })
  })

  it('reset returns to env, keeps growing the revision and rejects stale ones', async () => {
    expect(await resetRuntimeSettings(0)).toBe(true)
    await saveRuntimeSettings(fields(), 0)
    expect(await resetRuntimeSettings(0)).toBe(false)
    expect(await resetRuntimeSettings(5)).toBe(false)
    expect(await resetRuntimeSettings(1)).toBe(true)
    expect(await loadRuntimeSettings()).toMatchObject({ source: 'env', revision: 2 })
    // A page that saw the saved copy (revision 1) can no longer match.
    expect(await saveRuntimeSettings(fields(), 1)).toBeNull()
    expect(await saveRuntimeSettings(fields(), 2)).toBe(3)
    expect(await resetRuntimeSettings(2)).toBe(false)
  })

  it('invalid stored JSON falls back to env, keeping the revision so a save can replace it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await query(
      `insert into runtime_settings (id, settings, revision) values (1, '{"dailyPostCount": 99}', 6)`,
    )
    expect(await loadRuntimeSettings()).toMatchObject({ source: 'env', revision: 6 })
    expect(err).toHaveBeenCalled()
    expect(await saveRuntimeSettings(fields(), 6)).toBe(7)
    expect(await loadRuntimeSettings()).toMatchObject({ source: 'db', revision: 7 })
    err.mockRestore()
  })
})

describe('consumers use the saved settings', () => {
  it('Threads rankCollected picks the saved count, an explicit count still wins', async () => {
    const [src] = await query<{ id: number }>(
      `insert into sources (name, url) values ('s', $1)
       on conflict (url) do update set name = 's' returning id`,
      [`https://example.com/feed-${process.pid}`],
    )
    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      const [t] = await query<{ id: number }>(
        `insert into topics (title, url, status, source_id) values ($1, $2, 'COLLECTED', $3)
         returning id`,
        [`t${i}`, `https://example.com/${i}`, src?.id],
      )
      ids.push((t as { id: number }).id)
    }
    const scores = () => ({
      scores: ids.map((id, i) => ({ id, score: 10 - i, reason: 'r', duplicate_of: null })),
    })
    chatJson.mockImplementation(async () => scores())
    await saveRuntimeSettings(fields({ dailyPostCount: 2 }), 0)
    expect(await rankCollected()).toEqual(ids.slice(0, 2))

    await query(`update topics set status = 'COLLECTED', updated_at = now()`)
    expect(await rankCollected(3)).toEqual(ids.slice(0, 3))
  })

  it('approvePost schedules on the saved slots', async () => {
    await saveRuntimeSettings(fields({ publishSlots: ['07:30'] }), 0)
    const postId = await seedPost(await seedTopic())
    const at = await approvePost(postId)
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: config.TZ_NAME,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at),
    ).toBe('07:30')
    expect((await getPost(postId)).status).toBe('SCHEDULED')
  })

  it('campaign ranking uses the saved daily max', async () => {
    config.CAMPAIGN_RANK_MODE = 'rule'
    await saveRuntimeSettings(fields({ campaignDailyMax: 1 }), 0)
    await seedCampaign({ applicationCount: 10, recruitCount: 10 })
    await seedCampaign({ applicationCount: 20, recruitCount: 10 })
    const picked = await rankCampaigns(new Date())
    expect(picked).toHaveLength(1)
    expect((await getCampaign(picked[0] as number)).status).toBe('SHORTLISTED')
  })

  it('loadOps shows current and env defaults with the right source', async () => {
    const env = await loadOps({ runs: async () => new Map() })
    expect(env.schedule).toMatchObject({ source: 'env', revision: 0 })
    expect(env.schedule.current).toEqual(env.schedule.defaults)

    await saveRuntimeSettings(fields(), 0)
    const ops = await loadOps({ runs: async () => new Map() })
    expect(ops.schedule).toMatchObject({
      source: 'db',
      revision: 1,
      current: {
        giftCollect: { cron: '10 8,14 * * *', daily: daily(10, [8, 14]) },
        dailyPostCount: 2,
      },
      defaults: { giftCollect: { cron: config.GIFT_COLLECT_CRON } },
    })
    expect(ops.jobs.find((j) => j.name === 'gift-collect')?.cron).toBe('10 8,14 * * *')
    expect(ops.settings).toMatchObject({ dailyPostCount: 2, publishSlots: ['07:30', '13:00'] })
  })
})

describe('applySchedules', () => {
  it('registers the saved crons, then the env crons after a reset', async () => {
    await saveRuntimeSettings(fields(), 0)
    await applySchedules(boss, TARGETS)
    expect(await cronOf(Q.daily)).toBe('0 5 * * *')
    expect(await cronOf(CQ.collect)).toBe('10 8,14 * * *')
    expect(await cronOf(CQ.musinsaCollect)).toBe('20 9 * * *')
    expect((await boss.getSchedules(CQ.collect))[0]?.timezone).toBe(config.TZ_NAME)

    await resetRuntimeSettings(1)
    await applySchedules(boss, TARGETS)
    expect(await cronOf(Q.daily)).toBe(config.COLLECT_CRON)
    expect(await cronOf(CQ.collect)).toBe(config.GIFT_COLLECT_CRON)
    expect(await cronOf(CQ.musinsaCollect)).toBe(config.MUSINSA_COLLECT_CRON)
  })

  it('only touches the queues it is given', async () => {
    await saveRuntimeSettings(fields(), 0)
    await applySchedules(boss, TARGETS)
    await saveRuntimeSettings(fields({ giftCollect: daily(1, [1]) }), 1)
    await applySchedules(boss, { threadsCollect: Q.daily })
    expect(await cronOf(CQ.collect)).toBe('10 8,14 * * *')
  })

  it('concurrent saves and applies end with the latest crons registered', async () => {
    let revision = 0
    for (let round = 0; round < 5; round++) {
      const hour = round + 1
      const saveAndApply = async () => {
        const next = await saveRuntimeSettings(fields({ giftCollect: daily(0, [hour]) }), revision)
        expect(next).not.toBeNull()
        revision = next as number
        await applySchedules(boss, TARGETS)
      }
      await Promise.all([
        applySchedules(boss, TARGETS),
        saveAndApply(),
        applySchedules(boss, TARGETS),
        applySchedules(boss, TARGETS),
      ])
      expect(await cronOf(CQ.collect)).toBe(dailyToCron(daily(0, [hour])))
    }
  })

  it('many waiting applies do not exhaust the pool', async () => {
    await saveRuntimeSettings(fields(), 0)
    await Promise.all(Array.from({ length: 12 }, () => applySchedules(boss, TARGETS)))
    expect(await cronOf(CQ.collect)).toBe('10 8,14 * * *')
  })
})

describe('createScheduleEdit', () => {
  it('saves, applies and answers the state; stale saves apply nothing', async () => {
    const apply = vi.fn(async () => {})
    const edit = createScheduleEdit(apply)
    const saved = await edit.save(fields(), 0)
    expect(saved).toMatchObject({
      ok: true,
      applied: true,
      schedule: { source: 'db', revision: 1 },
    })
    expect(apply).toHaveBeenCalledTimes(1)

    expect(await edit.save(fields(), 0)).toBeNull()
    expect(await edit.reset(0)).toBeNull()
    expect(apply).toHaveBeenCalledTimes(1)

    const reset = await edit.reset(1)
    expect(reset).toMatchObject({ applied: true, schedule: { source: 'env', revision: 2 } })
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('applied is false, and the save stays, when re-registering throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const edit = createScheduleEdit(async () => {
      throw new Error('boss down')
    })
    const saved = await edit.save(fields(), 0)
    expect(saved).toMatchObject({ ok: true, applied: false, schedule: { source: 'db' } })
    expect((await loadRuntimeSettings()).source).toBe('db')
    err.mockRestore()
  })
})
