import { describe, expect, it, vi } from 'vitest'
import { localHour } from '../src/lib/time.ts'
import {
  formatExpired,
  formatReminder,
  runReviewMaintenance,
  selectExpired,
  shouldRemind,
} from '../src/pipeline/maintenance.ts'

const now = new Date('2026-10-09T00:00:00Z') // 09:00 in Asia/Seoul
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000)

describe('selectExpired', () => {
  it('expires only drafts older than 48h', () => {
    const drafts = [
      { id: 1, lastTouchedAt: hoursAgo(49) },
      { id: 2, lastTouchedAt: hoursAgo(47) },
      { id: 3, lastTouchedAt: hoursAgo(48) },
    ]
    expect(selectExpired(drafts, now)).toEqual([1])
  })
})

describe('shouldRemind', () => {
  it('fires at 09 and 18 local time only, and only with pending drafts', () => {
    expect(localHour(now, 'Asia/Seoul')).toBe(9)
    expect(shouldRemind(now, 'Asia/Seoul', 2)).toBe(true)
    expect(shouldRemind(new Date('2026-10-09T09:00:00Z'), 'Asia/Seoul', 1)).toBe(true)
    expect(shouldRemind(new Date('2026-10-09T01:00:00Z'), 'Asia/Seoul', 1)).toBe(false)
    expect(shouldRemind(now, 'Asia/Seoul', 0)).toBe(false)
  })
})

describe('runReviewMaintenance', () => {
  const make = (pending: { id: number; h: number }[], expireResult?: number[]) => {
    const notify = vi.fn(async (_text: string) => {})
    const retire = vi.fn(async (_ids: number[]) => {})
    const expire = vi.fn(async (ids: number[]) => expireResult ?? ids)
    const deps = {
      loadPending: async () => pending.map((p) => ({ id: p.id, lastTouchedAt: hoursAgo(p.h) })),
      expire,
      retire,
      notify,
    }
    return { deps, notify, retire, expire }
  }

  it('expires, retires keyboards and reminds about the rest in one run', async () => {
    const { deps, notify, retire } = make([
      { id: 1, h: 60 },
      { id: 2, h: 5 },
    ])
    const res = await runReviewMaintenance(deps, now, 'Asia/Seoul')
    expect(res).toEqual({ expired: [1], remindedPending: [2] })
    expect(retire).toHaveBeenCalledWith([1])
    expect(notify).toHaveBeenNthCalledWith(1, formatExpired([1]))
    expect(notify).toHaveBeenNthCalledWith(2, formatReminder([2]))
  })
  it('does nothing outside reminder hours when nothing is stale', async () => {
    const { deps, notify, expire } = make([{ id: 2, h: 5 }])
    await runReviewMaintenance(deps, new Date('2026-10-09T03:00:00Z'), 'Asia/Seoul')
    expect(notify).not.toHaveBeenCalled()
    expect(expire).not.toHaveBeenCalled()
  })
  it('still reminds about drafts the guarded update refused to expire', async () => {
    const { deps, notify } = make([{ id: 1, h: 60 }], [])
    const res = await runReviewMaintenance(deps, now, 'Asia/Seoul')
    expect(res.expired).toEqual([])
    expect(notify).toHaveBeenCalledWith(formatReminder([1]))
  })
})
