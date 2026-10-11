import { describe, expect, it, vi } from 'vitest'
import { findMediaIdByText } from '../src/pipeline/chain.ts'
import { decideAfterFailure, driveContainer, LostClaimError } from '../src/pipeline/publish.ts'
import { type ContainerStatus, parseOwnPosts, type ThreadsApi } from '../src/threads/client.ts'

function fakeApi(statuses: ContainerStatus[]) {
  const queue = [...statuses]
  return {
    createTextContainer: vi.fn(async () => 'new-container'),
    getContainerStatus: vi.fn(async () => ({ status: queue.shift() ?? 'FINISHED' })),
    publish: vi.fn(async (id: string) => `post-of-${id}`),
    refreshToken: vi.fn(),
    me: vi.fn(),
    getInsights: vi.fn(),
    listReplies: vi.fn(),
    listMyThreads: vi.fn(),
    listMyReplies: vi.fn(),
  } satisfies ThreadsApi
}

const post = { text: 'hello' }
const noSleep = async () => {}

describe('driveContainer', () => {
  it('creates, persists, waits for FINISHED, then publishes', async () => {
    const api = fakeApi(['IN_PROGRESS', 'FINISHED'])
    const onContainer = vi.fn(async () => {})
    const result = await driveContainer(api, post, null, onContainer, { sleep: noSleep })
    expect(onContainer).toHaveBeenCalledWith('new-container')
    expect(api.publish).toHaveBeenCalledWith('new-container')
    expect(result.platformPostId).toBe('post-of-new-container')
  })

  it('reuses an existing container instead of creating a second one', async () => {
    const api = fakeApi(['FINISHED', 'FINISHED'])
    await driveContainer(api, post, 'old', async () => {}, { sleep: noSleep })
    expect(api.createTextContainer).not.toHaveBeenCalled()
    expect(api.publish).toHaveBeenCalledWith('old')
  })

  it('does not publish again when the container is already published', async () => {
    const api = fakeApi(['PUBLISHED'])
    const result = await driveContainer(api, post, 'old', async () => {}, { sleep: noSleep })
    expect(api.publish).not.toHaveBeenCalled()
    expect(result.platformPostId).toBeNull()
  })

  it('replaces an expired container', async () => {
    const api = fakeApi(['EXPIRED', 'FINISHED'])
    await driveContainer(api, post, 'old', async () => {}, { sleep: noSleep })
    expect(api.createTextContainer).toHaveBeenCalledOnce()
    expect(api.publish).toHaveBeenCalledWith('new-container')
  })

  it('gives up when the container never finishes', async () => {
    const api = fakeApi(Array(20).fill('IN_PROGRESS'))
    await expect(
      driveContainer(api, post, null, async () => {}, { sleep: noSleep, maxPolls: 3 }),
    ).rejects.toThrow('still IN_PROGRESS')
    expect(api.publish).not.toHaveBeenCalled()
  })

  it('does not publish when ownership is lost before publish', async () => {
    const api = fakeApi(['FINISHED'])
    const beforePublish = vi.fn(async () => {
      throw new LostClaimError()
    })
    await expect(
      driveContainer(api, post, 'old', async () => {}, { sleep: noSleep, beforePublish }),
    ).rejects.toBeInstanceOf(LostClaimError)
    expect(api.publish).not.toHaveBeenCalled()
  })

  it('does not publish when onContainer reports a lost claim', async () => {
    const api = fakeApi(['FINISHED'])
    const onContainer = vi.fn(async () => {
      throw new LostClaimError()
    })
    await expect(
      driveContainer(api, post, null, onContainer, { sleep: noSleep }),
    ).rejects.toBeInstanceOf(LostClaimError)
    expect(api.publish).not.toHaveBeenCalled()
  })

  it('checks ownership right before publishing', async () => {
    const api = fakeApi(['FINISHED'])
    const beforePublish = vi.fn(async () => {
      expect(api.publish).not.toHaveBeenCalled()
    })
    await driveContainer(api, post, 'old', async () => {}, { sleep: noSleep, beforePublish })
    expect(beforePublish).toHaveBeenCalledOnce()
    expect(api.publish).toHaveBeenCalledOnce()
  })
})

describe('decideAfterFailure', () => {
  it('trusts a PUBLISHED container even on the final attempt', () => {
    expect(decideAfterFailure({ attempts: 3, containerStatus: 'PUBLISHED' })).toBe('published')
  })
  it('retries before the final attempt', () => {
    expect(decideAfterFailure({ attempts: 1, containerStatus: 'ERROR' })).toBe('retry')
  })
  it('fails on the final attempt when the container is not published', () => {
    expect(decideAfterFailure({ attempts: 3, containerStatus: 'ERROR' })).toBe('failed')
    expect(decideAfterFailure({ attempts: 3, containerStatus: null })).toBe('failed')
  })
  it('stays retryable when the status check failed on the final attempt', () => {
    expect(decideAfterFailure({ attempts: 3, containerStatus: 'unknown' })).toBe('retry')
  })
  it('stops retrying an unknown outcome after the extra attempts run out', () => {
    expect(decideAfterFailure({ attempts: 5, containerStatus: 'unknown' })).toBe('retry')
    expect(decideAfterFailure({ attempts: 6, containerStatus: 'unknown' })).toBe('failed')
  })
})

describe('driveContainer with replyToId', () => {
  it('passes the parent media id through to the container', async () => {
    const api = fakeApi(['FINISHED'])
    await driveContainer(api, { text: 'reply', replyToId: 'parent-1' }, null, async () => {}, {
      sleep: noSleep,
    })
    expect(api.createTextContainer).toHaveBeenCalledWith({ text: 'reply', replyToId: 'parent-1' })
  })
})

describe('findMediaIdByText', () => {
  const item = (id: string, text: string | null) => ({ id, text, timestamp: null })
  it('returns the newest exact match, ignoring surrounding whitespace', () => {
    const items = [item('new', 'hello\n'), item('mid', 'other'), item('old', 'hello')]
    expect(findMediaIdByText(items, 'hello')).toBe('new')
  })
  it('does not match a different or text-less post', () => {
    expect(findMediaIdByText([item('a', 'hello world'), item('b', null)], 'hello')).toBeNull()
  })
})

describe('parseOwnPosts', () => {
  it('keeps order and tolerates missing text and bad timestamps', () => {
    const parsed = parseOwnPosts({
      data: [
        { id: '1', text: 'a', timestamp: '2026-01-02T03:04:05+0000' },
        { id: '2', timestamp: 'garbage' },
        { id: '3', text: '  ' },
      ],
    })
    expect(parsed.map((p) => [p.id, p.text])).toEqual([
      ['1', 'a'],
      ['2', null],
      ['3', null],
    ])
    expect(parsed[1]?.timestamp).toBeNull()
  })
  it('treats a missing data field as empty', () => {
    expect(parseOwnPosts({})).toEqual([])
  })
})
