import { describe, expect, it } from 'vitest'
import { dailyToCron, parseDailyCron, parseScheduleInput } from '../src/settings.ts'

describe('cron <-> DailySchedule', () => {
  it('round trips the simple daily form', () => {
    for (const cron of ['0 6 * * *', '0 9,15,21 * * *', '30 0,23 * * *']) {
      const d = parseDailyCron(cron)
      expect(d).not.toBeNull()
      expect(dailyToCron(d as never)).toBe(cron)
    }
    expect(parseDailyCron('0 9,15,21 * * *')).toEqual({ minute: 0, hours: [9, 15, 21] })
  })

  it('normalizes hour order and duplicates, tolerates spaces', () => {
    expect(parseDailyCron('  5  21,9,9 * * * ')).toEqual({ minute: 5, hours: [9, 21] })
  })

  it.each([
    '*/5 * * * *',
    '0 */6 * * *',
    '0 9-12 * * *',
    '0 9 * * 1',
    '0 9 1 * *',
    '0 9 * 1 *',
    '0,30 9 * * *',
    '* 9 * * *',
    '0 * * * *',
    '60 9 * * *',
    '0 24 * * *',
    '0 9,,10 * * *',
    '0 9 * *',
    '0 9 * * * *',
    '',
  ])('returns null for %j', (cron) => {
    expect(parseDailyCron(cron)).toBeNull()
  })
})

const valid = {
  threadsCollect: { minute: 0, hours: [6] },
  giftCollect: { minute: 0, hours: [9, 15, 21] },
  musinsaCollect: { minute: 0, hours: [10, 16, 22] },
  dailyPostCount: 3,
  publishSlots: ['08:00', '12:30', '21:00'],
  campaignDailyMax: 5,
}
const fieldsOf = (patch: Record<string, unknown>) => {
  const r = parseScheduleInput({ ...valid, ...patch })
  return r.ok ? null : r.fields
}

describe('parseScheduleInput', () => {
  it('accepts a valid schedule unchanged', () => {
    expect(parseScheduleInput(valid)).toEqual({ ok: true, schedule: valid })
  })

  it('dedupes and sorts hours and slots, zero pads and trims slots', () => {
    const r = parseScheduleInput({
      ...valid,
      giftCollect: { minute: 5, hours: [21, 9, 9, 15] },
      publishSlots: ['21:00', ' 8:05 ', '08:05', '12:30'],
    })
    expect(r).toMatchObject({
      ok: true,
      schedule: {
        giftCollect: { minute: 5, hours: [9, 15, 21] },
        publishSlots: ['08:05', '12:30', '21:00'],
      },
    })
  })

  it('enforces the limits with dotted paths', () => {
    expect(fieldsOf({ giftCollect: { minute: 60, hours: [1] } })).toEqual(['giftCollect.minute'])
    expect(fieldsOf({ giftCollect: { minute: 0, hours: [] } })).toEqual(['giftCollect.hours'])
    expect(fieldsOf({ musinsaCollect: { minute: 0, hours: [24] } })).toEqual([
      'musinsaCollect.hours.0',
    ])
    expect(fieldsOf({ threadsCollect: { minute: 0, hours: [1.5] } })).toEqual([
      'threadsCollect.hours.0',
    ])
    expect(fieldsOf({ dailyPostCount: 0 })).toEqual(['dailyPostCount'])
    expect(fieldsOf({ dailyPostCount: 11 })).toEqual(['dailyPostCount'])
    expect(fieldsOf({ campaignDailyMax: 21 })).toEqual(['campaignDailyMax'])
    expect(fieldsOf({ campaignDailyMax: 0 })).toEqual(['campaignDailyMax'])
    expect(fieldsOf({ publishSlots: [] })).toEqual(['publishSlots'])
    expect(fieldsOf({ publishSlots: ['08:00', '8', '24:00', '09:60'] })).toEqual([
      'publishSlots.1',
      'publishSlots.2',
      'publishSlots.3',
    ])
    const eleven = Array.from({ length: 11 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
    expect(fieldsOf({ publishSlots: eleven })).toEqual(['publishSlots'])
    expect(fieldsOf({ publishSlots: eleven.slice(0, 10) })).toBeNull()
  })

  it('accepts 24 hours and rejects non-objects and missing fields', () => {
    const all = Array.from({ length: 24 }, (_, i) => i)
    expect(fieldsOf({ giftCollect: { minute: 0, hours: all } })).toBeNull()
    expect(parseScheduleInput(null)).toEqual({ ok: false, fields: ['schedule'] })
    const { dailyPostCount: _drop, ...rest } = valid
    expect(parseScheduleInput(rest)).toEqual({ ok: false, fields: ['dailyPostCount'] })
  })
})
