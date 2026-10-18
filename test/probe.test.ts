import { describe, expect, it } from 'vitest'
import { formatProbe, isNewestFirst, runProbe } from '../src/threads/probe.ts'
import { FakeThreads } from './fake-threads.ts'

const at = (iso: string) => ({ id: iso, text: 'x', timestamp: new Date(iso), repliedToId: null })

describe('isNewestFirst', () => {
  it('accepts descending timestamps and ignores missing ones', () => {
    expect(isNewestFirst([at('2026-10-03'), at('2026-10-02'), at('2026-10-01')])).toBe(true)
    expect(isNewestFirst([at('2026-10-01'), at('2026-10-02')])).toBe(false)
    expect(isNewestFirst([])).toBe(true)
  })
})

describe('runProbe', () => {
  it('reports the replied_to coverage the chain recovery depends on', async () => {
    const api = Object.assign(new FakeThreads(), {
      me: async () => ({ id: '1', username: 'owner' }),
      getInsights: async () => ({
        views: 10,
        likes: 1,
        replies: null,
        reposts: null,
        quotes: null,
        shares: null,
      }),
    })
    const main = api.addLiveThread('hello world')
    api.addLiveReply('reply with parent', main)
    api.addLiveReply('reply without parent', null)

    const report = await runProbe(api)
    expect(report.replies).toMatchObject({ ok: true, count: 2, withRepliedTo: 1 })
    expect(report.insights).toMatchObject({ ok: true, metrics: ['views', 'likes'] })
    const text = formatProbe(report)
    expect(text).toContain('@owner')
    expect(text).toContain('FAIL /me/replies: replied_to on 1/2')
  })

  it('keeps going when one call fails and asks for a reply when there is none', async () => {
    const api = Object.assign(new FakeThreads(), {
      me: async () => {
        throw new Error('Threads GET /me 401')
      },
    })
    const text = formatProbe(await runProbe(api))
    expect(text).toContain('FAIL token owner: Threads GET /me 401')
    expect(text).toContain('OK   /me/threads: 0 item(s)')
    expect(text).toContain('no replies on this account')
  })
})
