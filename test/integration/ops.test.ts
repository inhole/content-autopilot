import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CQ } from '../../src/campaigns/jobs.ts'
import { type Query, query } from '../../src/db/pool.ts'
import { createBoss, Q } from '../../src/jobs.ts'
import { loadOps, loadProfileForOps, loadQueueRuns, runOpsJob } from '../../src/web/ops.ts'

let boss: PgBoss
const QUEUES = [CQ.collect, CQ.musinsaCollect, CQ.maintenance]

beforeAll(async () => {
  boss = createBoss()
  await boss.start()
  for (const q of QUEUES) await boss.createQueue(q, { policy: 'stately', retryLimit: 0 })
  // Same policy as the worker gives it: singleton limits active jobs only.
  await boss.createQueue(Q.daily, { policy: 'singleton', retryLimit: 0 })
  await query('delete from pgboss.job where name = any($1)', [[...QUEUES, Q.daily]])
})
afterAll(async () => {
  await boss.stop({ graceful: false })
})

describe('ops job state', () => {
  it('never ran: no last, not busy', async () => {
    const runs = await loadQueueRuns([CQ.maintenance, 'no-such-queue'])
    expect(runs.get(CQ.maintenance)).toEqual({ last: null, busy: false })
    expect(runs.get('no-such-queue')).toEqual({ last: null, busy: false })
  })

  it('queued job is busy; completed job is last and not busy', async () => {
    expect(await boss.send(CQ.collect, null)).not.toBeNull()
    let run = (await loadQueueRuns([CQ.collect])).get(CQ.collect)
    expect(run?.busy).toBe(true)
    expect(run?.last).toMatchObject({ state: 'created', started_at: null, error: null })

    // A second request is reported as not queued instead of stacking.
    expect(await runOpsJob('gift-collect', { send: (q) => boss.send(q, null) })).toBe(false)

    const [job] = await boss.fetch(CQ.collect)
    await boss.complete(CQ.collect, (job as { id: string }).id)
    run = (await loadQueueRuns([CQ.collect])).get(CQ.collect)
    expect(run?.busy).toBe(false)
    expect(run?.last).toMatchObject({ state: 'completed', error: null })
    expect(run?.last?.completed_at).toBeInstanceOf(Date)
    expect(await runOpsJob('gift-collect', { send: (q) => boss.send(q, null) })).toBe(true)
  })

  it('concurrent run requests on a singleton queue send one job', async () => {
    // The singleton policy only limits active jobs, so without the lock every request would queue.
    // The pause between the busy check and the send makes every request read "not busy" first
    // unless the lock serializes them.
    const send = (q: string) => boss.send(q, null)
    const runs = async (queues: string[], q: Query) => {
      const read = await loadQueueRuns(queues, q)
      await new Promise((r) => setTimeout(r, 100))
      return read
    }
    // More requests than the pool has clients (5): the waiters must not starve the lock holder.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runOpsJob('threads-daily', { send, runs })),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const [row] = await query<{ n: number }>(
      'select count(*)::int as n from pgboss.job where name = $1',
      [Q.daily],
    )
    expect(row?.n).toBe(1)
  })

  it('failed job keeps a short error without the stack', async () => {
    await boss.send(CQ.musinsaCollect, null)
    const [job] = await boss.fetch(CQ.musinsaCollect)
    await boss.fail(
      CQ.musinsaCollect,
      (job as { id: string }).id,
      new Error(`fetch failed ${'x'.repeat(500)}`),
    )
    const run = (await loadQueueRuns([CQ.musinsaCollect])).get(CQ.musinsaCollect)
    expect(run?.busy).toBe(false)
    expect(run?.last?.state).toBe('failed')
    expect(run?.last?.error).toMatch(/^fetch failed x+/)
    expect(run?.last?.error?.length).toBeLessThanOrEqual(300)
    expect(run?.last?.error).not.toContain('    at ')
  })

  it('loadOps maps jobs, settings and profile', async () => {
    const ops = await loadOps()
    expect(ops.jobs.map((j) => j.queue)).toEqual([
      'daily-pipeline',
      'gift-collect',
      'musinsa-collect',
      'campaign-maintenance',
      'collect-insights',
    ])
    expect(ops.jobs.find((j) => j.name === 'musinsa-collect')?.last?.state).toBe('failed')
    expect(ops.jobs.find((j) => j.name === 'collect-insights')).toMatchObject({
      cron: '0 5 * * *',
      last: null,
      busy: false,
    })
    expect(ops.settings.dailyPostCount).toBeGreaterThan(0)
    expect(ops.settings.timeZone).toBeTruthy()
    expect(JSON.stringify(ops.settings)).not.toMatch(/token|chat/i)
  })

  it('profile: parsed fields, null on load failure', async () => {
    const p = await loadProfileForOps(async () => ({
      source: 'file',
      revision: 0,
      profile: {
        about: 'a',
        interests: ['i'],
        preferKeywords: [],
        excludeKeywords: ['x'],
        excludeBrands: [],
        review: { tone: 't', minChars: 100, maxChars: 500, points: [] },
      },
    }))
    expect(p).toMatchObject({
      about: 'a',
      maxCompetition: null,
      minPriceWon: null,
      disclosure: null,
      source: 'file',
      revision: 0,
      review: { minChars: 100 },
    })
    expect(
      await loadProfileForOps(async () => {
        throw new Error('missing')
      }),
    ).toBeNull()
  })
})
