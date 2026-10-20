import { describe, expect, it } from 'vitest'
import { acceptVerdicts, ageInDays, type RevivablePost } from '../src/pipeline/revive.ts'
import {
  formatReviveList,
  parseRevive,
  REVIVE_BOT_COMMANDS,
  reviveKeyboard,
} from '../src/pipeline/revive-bot.ts'
import { judgePrompt, REVIVE_SYSTEM, revivePrompt } from '../src/pipeline/revive-prompts.ts'

const TZ = 'Asia/Seoul'
const now = new Date('2026-10-19T03:00:00Z')

const post = (id: number, verdict: RevivablePost['verdict'], daysAgo: number): RevivablePost => ({
  id,
  title: `title ${id}`,
  text: 'text',
  sourceUrl: null,
  createdAt: new Date(now.getTime() - daysAgo * 86_400_000),
  verdict,
  reason: verdict ? `reason ${id}` : null,
  checkedAt: verdict ? now : null,
})

describe('ageInDays', () => {
  it('counts calendar days in KST, not 24h blocks', () => {
    // 23:30 KST the previous day is one calendar day earlier than 00:30 KST.
    expect(ageInDays(new Date('2026-10-17T14:30:00Z'), new Date('2026-10-17T15:30:00Z'), TZ)).toBe(
      1,
    )
    expect(ageInDays(new Date('2026-10-12T03:00:00Z'), now, TZ)).toBe(7)
    expect(ageInDays(now, now, TZ)).toBe(0)
  })
})

describe('acceptVerdicts', () => {
  it('ignores unknown ids and keeps the first verdict per id', () => {
    const out = acceptVerdicts(
      [1, 2],
      [
        { id: 1, verdict: 'evergreen', reason: ' ok ' },
        { id: 1, verdict: 'stale', reason: 'dup' },
        { id: 99, verdict: 'stale', reason: 'unknown' },
      ],
    )
    expect([...out.keys()]).toEqual([1])
    expect(out.get(1)).toEqual({ verdict: 'evergreen', reason: 'ok' })
  })
})

describe('prompts', () => {
  it('revive prompt carries both dates and the age', () => {
    const p = revivePrompt({
      title: 'T',
      text: '본문',
      createdDate: '2026-09-20',
      today: '2026-10-19',
      ageDays: 29,
    })
    expect(p).toContain('2026-09-20')
    expect(p).toContain('2026-10-19')
    expect(p).toContain('29일 전')
    expect(p).toContain('본문')
  })

  it('revive system keeps the voice rules and the no-new-facts rule', () => {
    expect(REVIVE_SYSTEM).toContain('반말')
    expect(REVIVE_SYSTEM).toContain('새로운 사실')
    expect(REVIVE_SYSTEM).toContain('이번 주')
  })

  it('judge prompt lists every draft with its id', () => {
    const p = judgePrompt([
      { id: 3, title: 'a', text: 'x', ageDays: 2 },
      { id: 4, title: 'b', text: 'y', ageDays: 9 },
    ])
    expect(p).toContain('[id 3]')
    expect(p).toContain('[id 4]')
    expect(p).toContain('9일 전')
  })
})

describe('list formatting', () => {
  it('shows an empty state', () => {
    expect(formatReviveList([], now, TZ)).toBe('살릴 만한 만료 초안이 없어요')
    expect(formatReviveList([post(1, null, 3)], now, TZ)).toBe('살릴 만한 만료 초안이 없어요')
  })

  it('lists evergreen first with reason and age, stale under the digest heading', () => {
    const text = formatReviveList([post(1, 'stale', 5), post(2, 'evergreen', 3)], now, TZ)
    expect(text.indexOf('#2')).toBeLessThan(text.indexOf('주간 묶음 후보'))
    expect(text.indexOf('주간 묶음 후보')).toBeLessThan(text.indexOf('#1'))
    expect(text).toContain('3일 전')
    expect(text).toContain('reason 2')
  })

  it('builds one button per evergreen post only', () => {
    const kb = reviveKeyboard([
      post(1, 'stale', 5),
      post(2, 'evergreen', 3),
      post(3, 'evergreen', 4),
    ])
    const buttons = kb.inline_keyboard.flat()
    expect(buttons.map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([
      'rv:2',
      'rv:3',
    ])
    expect(parseRevive('rv:2')).toBe(2)
    expect(parseRevive('rv:x')).toBeNull()
    expect(REVIVE_BOT_COMMANDS[0]?.command).toBe('revive')
  })
})
