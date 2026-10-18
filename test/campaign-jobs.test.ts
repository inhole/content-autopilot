import { describe, expect, it } from 'vitest'
import { CQ, isReminderHour } from '../src/campaigns/jobs.ts'

const TZ = 'Asia/Seoul'
const kst = (time: string) => new Date(`2026-10-18T${time}:00+09:00`)

describe('isReminderHour', () => {
  it('allows 09:00 through 21:59 local time', () => {
    expect(isReminderHour(kst('08:59'), TZ)).toBe(false)
    expect(isReminderHour(kst('09:00'), TZ)).toBe(true)
    expect(isReminderHour(kst('21:59'), TZ)).toBe(true)
    expect(isReminderHour(kst('22:00'), TZ)).toBe(false)
    expect(isReminderHour(kst('00:00'), TZ)).toBe(false)
  })
  it('uses the local hour, not UTC', () => {
    // 00:30 UTC is 09:30 in Seoul and 20:30 the day before in New York; 14:00 UTC is 23:00 in Seoul.
    const instant = new Date('2026-10-18T00:30:00Z')
    expect(isReminderHour(instant, TZ)).toBe(true)
    expect(isReminderHour(instant, 'America/New_York')).toBe(true)
    expect(isReminderHour(new Date('2026-10-18T14:00:00Z'), TZ)).toBe(false)
    expect(isReminderHour(new Date('2026-10-18T14:00:00Z'), 'America/New_York')).toBe(true)
  })
})

describe('campaign queue names', () => {
  it('are unique and do not clash with the Threads queues', () => {
    const names = Object.values(CQ)
    expect(new Set(names).size).toBe(names.length)
  })
})
