import { describe, expect, it } from 'vitest'
import { nextFreeSlot, zonedToUtc } from '../src/lib/time.ts'

const TZ = 'Asia/Seoul'
const slots = ['08:00', '12:30', '19:00']

describe('zonedToUtc', () => {
  it('converts Seoul wall time to UTC', () => {
    expect(zonedToUtc('2026-10-05', '08:00', TZ).toISOString()).toBe('2026-10-04T23:00:00.000Z')
  })

  it('handles DST zones', () => {
    // New York is UTC-4 in July and UTC-5 in January.
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    )
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    )
  })
})

describe('nextFreeSlot', () => {
  it('picks the next slot later today', () => {
    // 10:00 KST
    const now = new Date('2026-10-05T01:00:00Z')
    expect(nextFreeSlot({ now, slots, timeZone: TZ, taken: [] }).toISOString()).toBe(
      '2026-10-05T03:30:00.000Z',
    )
  })

  it('skips taken slots and rolls over to tomorrow', () => {
    // 13:00 KST, 19:00 already taken
    const now = new Date('2026-10-05T04:00:00Z')
    const taken = [new Date('2026-10-05T10:00:00Z')]
    expect(nextFreeSlot({ now, slots, timeZone: TZ, taken }).toISOString()).toBe(
      '2026-10-05T23:00:00.000Z',
    )
  })

  it('does not pick a slot inside the buffer', () => {
    // 07:59 KST: 08:00 is within the 2 minute buffer
    const now = new Date('2026-10-04T22:59:00Z')
    expect(nextFreeSlot({ now, slots, timeZone: TZ, taken: [] }).toISOString()).toBe(
      '2026-10-05T03:30:00.000Z',
    )
  })
})
