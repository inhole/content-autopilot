/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** Local calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant)
}

/** Local hour (0-23) of `instant` in `timeZone`. */
export function localHour(instant: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' })
    .formatToParts(instant)
    .find((p) => p.type === 'hour')
  return Number(part?.value)
}

/** The UTC instant for wall-clock `date` (YYYY-MM-DD) + `time` (HH:MM) in `timeZone`. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0)
  const first = guess - tzOffsetMs(new Date(guess), timeZone)
  // Re-check once in case the guess and the result straddle a DST change.
  return new Date(guess - tzOffsetMs(new Date(first), timeZone))
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Earliest publish slot after `now` + `bufferMs` that no other post occupies.
 * Slots are local "HH:MM" times in `timeZone`.
 */
export function nextFreeSlot(opts: {
  now: Date
  slots: string[]
  timeZone: string
  taken: Date[]
  bufferMs?: number
  maxDays?: number
}): Date {
  const earliest = opts.now.getTime() + (opts.bufferMs ?? 2 * 60_000)
  const taken = new Set(opts.taken.map((d) => d.getTime()))
  const slots = [...opts.slots].sort()
  const today = localDate(opts.now, opts.timeZone)
  for (let day = 0; day < (opts.maxDays ?? 30); day++) {
    const date = addDays(today, day)
    for (const slot of slots) {
      const at = zonedToUtc(date, slot, opts.timeZone)
      if (at.getTime() >= earliest && !taken.has(at.getTime())) return at
    }
  }
  throw new Error('no free publish slot found')
}
