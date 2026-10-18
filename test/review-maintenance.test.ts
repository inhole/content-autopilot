import { describe, expect, it, vi } from 'vitest'
import { localHour } from '../src/lib/time.ts'
import {
  formatExpired,
  formatExpiryWarning,
  formatReminder,
  runReviewMaintenance,
  selectExpired,
  selectExpiringSoon,
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
  const make = (pending: { id: number; h: number; warned?: number }[], expireResult?: number[]) => {
    const notify = vi.fn(async (_text: string) => {})
    const retire = vi.fn(async (_ids: number[]) => {})
    const expire = vi.fn(async (ids: number[]) => expireResult ?? ids)
    const markWarned = vi.fn(async (_ids: number[]) => {})
    const deps = {
      loadExpiring: async () =>
        pending.map((p) => ({
          id: p.id,
          lastTouchedAt: hoursAgo(p.h),
          warnedAt: p.warned === undefined ? null : hoursAgo(p.warned),
        })),
      markWarned,
      loadPending: async () => pending.map((p) => ({ id: p.id, lastTouchedAt: hoursAgo(p.h) })),
      expire,
      retire,
      notify,
    }
    return { deps, notify, retire, expire, markWarned }
  }

  it('expires, retires keyboards and reminds about the rest in one run', async () => {
    const { deps, notify, retire } = make([
      { id: 1, h: 60 },
      { id: 2, h: 5 },
    ])
    const res = await runReviewMaintenance(deps, now, 'Asia/Seoul')
    expect(res).toEqual({ expired: [1], remindedPending: [2], warned: [] })
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

describe('selectExpiringSoon', () => {
  const pick = (h: number, warned: number | null = null) =>
    selectExpiringSoon(
      [{ id: 1, lastTouchedAt: hoursAgo(h), warnedAt: warned === null ? null : hoursAgo(warned) }],
      now,
    ).map((d) => d.id)

  it('warns from exactly 24h left, never at 0h left or later', () => {
    expect(pick(23.99)).toEqual([]) // 24.01h left
    expect(pick(24)).toEqual([1]) // exactly 24h left
    expect(pick(47.99)).toEqual([1])
    expect(pick(48)).toEqual([]) // 0h left: it expires instead
    expect(pick(49)).toEqual([])
  })
  it('skips drafts already warned for this touch', () => {
    expect(pick(30, 2)).toEqual([])
  })
  it('warns again after a later touch restarted the clock', () => {
    expect(pick(30, 31)).toEqual([1]) // warned before the last touch
  })
  it('reports the expiry instant', () => {
    expect(
      selectExpiringSoon([{ id: 1, lastTouchedAt: hoursAgo(30), warnedAt: null }], now)[0]
        ?.expiresAt,
    ).toEqual(hoursAgo(-18))
  })
})

describe('formatExpiryWarning', () => {
  it('shows local expiry times relative to today', () => {
    // now = 2026-10-09 09:00 KST; expiry 12:00Z = 21:00 KST today, 00:00Z next day = 09:00 KST tomorrow
    const text = formatExpiryWarning(
      [
        { id: 12, expiresAt: new Date('2026-10-09T12:00:00Z') },
        { id: 13, expiresAt: new Date('2026-10-09T18:00:00Z') },
      ],
      now,
      'Asia/Seoul',
    )
    expect(text).toBe(
      '⏳ 내일 만료되는 초안 2건: #12 (오늘 21시까지), #13 (내일 03시까지)\n검수 메시지에서 승인하거나, 답장으로 고치면 만료가 48시간 늦춰져요',
    )
  })
})

describe('runReviewMaintenance warnings', () => {
  const setup = (pending: { id: number; h: number; warned?: number }[]) => {
    const notify = vi.fn(async (_t: string) => {})
    const markWarned = vi.fn(async (_ids: number[]) => {})
    const deps = {
      loadPending: async () => pending.map((p) => ({ id: p.id, lastTouchedAt: hoursAgo(p.h) })),
      loadExpiring: async () =>
        pending.map((p) => ({
          id: p.id,
          lastTouchedAt: hoursAgo(p.h),
          warnedAt: p.warned === undefined ? null : hoursAgo(p.warned),
        })),
      expire: async (ids: number[]) => ids,
      retire: async () => {},
      markWarned,
      notify,
    }
    return { deps, notify, markWarned }
  }
  const off = new Date('2026-10-09T03:00:00Z') // 12:00 KST, no reminder

  it('sends one message for all newly warned drafts, then marks them', async () => {
    const { deps, notify, markWarned } = setup([
      { id: 1, h: 30 },
      { id: 2, h: 40 },
      { id: 3, h: 10 },
    ])
    const res = await runReviewMaintenance(deps, off, 'Asia/Seoul')
    expect(res.warned).toEqual([1, 2])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toContain('#1 (')
    expect(markWarned).toHaveBeenCalledWith([1, 2])
    expect(notify.mock.invocationCallOrder[0]).toBeLessThan(
      markWarned.mock.invocationCallOrder[0] ?? 0,
    )
  })
  it('does not mark anything when the send throws', async () => {
    const { deps, notify, markWarned } = setup([{ id: 1, h: 30 }])
    notify.mockRejectedValueOnce(new Error('telegram down'))
    await expect(runReviewMaintenance(deps, off, 'Asia/Seoul')).rejects.toThrow('telegram down')
    expect(markWarned).not.toHaveBeenCalled()
  })
  it('does not warn drafts that expire in the same run, or already warned ones', async () => {
    const { deps, notify, markWarned } = setup([
      { id: 1, h: 49 },
      { id: 2, h: 30, warned: 5 },
    ])
    const res = await runReviewMaintenance(deps, off, 'Asia/Seoul')
    expect(res.warned).toEqual([])
    expect(markWarned).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1) // only the expiry notice
  })
})
