import type { PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/schedules.ts', () => ({ applySchedules: async () => {} }))
vi.mock('../src/pipeline/digest.ts', () => ({
  digestPostIdForTopic: async () => null,
  regenerateDigest: async () => null,
}))
vi.mock('../src/pipeline/generate.ts', async (orig) => {
  const mod = await orig<typeof import('../src/pipeline/generate.ts')>()
  return {
    ...mod,
    generatePost: async (topicId: number) => {
      throw new mod.SkipTopicError(`topic ${topicId}: no readable article body`)
    },
  }
})

import { Q, registerJobs } from '../src/jobs.ts'
import type { Reviewer } from '../src/review/telegram.ts'

type Handler = (jobs: unknown[]) => Promise<void>

describe('generate job', () => {
  it('tells the owner when a topic is skipped for an unreadable body', async () => {
    const handlers = new Map<string, Handler>()
    const boss = {
      createQueue: async () => {},
      schedule: async () => {},
      send: async () => null,
      work: async (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest.at(-1) as Handler)
      },
    } as unknown as PgBoss
    const notes: string[] = []
    const reviewer = { notify: async (text: string) => void notes.push(text) } as Reviewer
    await registerJobs(boss, reviewer)

    await handlers.get(Q.generate)?.([{ data: { topicId: 42 }, retryCount: 0 }])

    expect(notes).toEqual(['⚠️ 주제 #42: 본문을 읽지 못해 건너뛰었어요'])
  })
})
