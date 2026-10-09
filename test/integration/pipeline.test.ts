import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { generatePost, requestRegeneration } from '../../src/pipeline/generate.ts'
import { approvePost, publishPost } from '../../src/pipeline/publish.ts'
import { DryRunThreadsClient, type ThreadsApi } from '../../src/threads/client.ts'
import { getPost, seedPost, seedTopic } from './helpers.ts'

async function newDraft(opts: { status?: string; scheduledAt?: Date | null } = {}) {
  const topicId = await seedTopic()
  return { topicId, postId: await seedPost(topicId, opts) }
}

describe('approvePost', () => {
  it('refuses a stale revision and schedules with the current one', async () => {
    const { postId } = await newDraft()
    await query('update posts set revision = 2 where id = $1', [postId])

    await expect(approvePost(postId, { revision: 1 })).rejects.toThrow(/changed/)
    expect((await getPost(postId)).status).toBe('PENDING_REVIEW')

    const at = await approvePost(postId, { revision: 2 })
    const post = await getPost(postId)
    expect(post.status).toBe('SCHEDULED')
    expect(post.scheduled_at?.getTime()).toBe(at.getTime())
  })

  it('gives concurrent approvals distinct slots', async () => {
    const drafts = []
    for (let i = 0; i < 3; i++) drafts.push(await newDraft())
    const slots = await Promise.all(drafts.map((d) => approvePost(d.postId)))
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(drafts.length)
  })
})

describe('publishPost', () => {
  const scheduledDraft = () =>
    newDraft({ status: 'SCHEDULED', scheduledAt: new Date(Date.now() - 60_000) })

  it('publishes with the dry-run client and records claim_seq 1', async () => {
    const { postId } = await scheduledDraft()
    const outcome = await publishPost(postId, new DryRunThreadsClient())
    expect(outcome.kind).toBe('published')
    const post = await getPost(postId)
    expect(post.status).toBe('PUBLISHED')
    expect(post.claim_seq).toBe(1)
  })

  it('returns skipped and never publishes when the claim is lost mid-flight', async () => {
    const { postId } = await scheduledDraft()
    let published = false
    const base = new DryRunThreadsClient()
    const api: ThreadsApi = {
      createTextContainer: async (post) => {
        // Simulates the stale-claim sweep handing the row to another worker.
        await query('update posts set claim_seq = claim_seq + 1 where id = $1', [postId])
        return base.createTextContainer(post)
      },
      getContainerStatus: () => base.getContainerStatus(),
      publish: async (id) => {
        published = true
        return base.publish(id)
      },
      refreshToken: () => base.refreshToken(),
      me: () => base.me(),
    }
    const outcome = await publishPost(postId, api)
    expect(outcome.kind).toBe('skipped')
    expect(published).toBe(false)
    expect((await getPost(postId)).container_id).toBeNull()
  })

  it('never repeats claim_seq even when attempts is reset', async () => {
    const { postId } = await scheduledDraft()
    await publishPost(postId, new DryRunThreadsClient())
    const first = (await getPost(postId)).claim_seq

    // What CLI publish-now does: reset attempts and make the post due again.
    await query("update posts set status = 'SCHEDULED', attempts = 0 where id = $1", [postId])
    await publishPost(postId, new DryRunThreadsClient())
    const second = await getPost(postId)
    expect(second.attempts).toBe(1)
    expect(second.claim_seq).toBeGreaterThan(first)
  })
})

describe('requestRegeneration', () => {
  it('returns increasing sequence numbers while the draft is under review', async () => {
    const { topicId } = await newDraft()
    expect(await requestRegeneration(topicId)).toBe(1)
    expect(await requestRegeneration(topicId)).toBe(2)
  })

  it('returns null when the post is not PENDING_REVIEW', async () => {
    const { topicId } = await newDraft({ status: 'SCHEDULED', scheduledAt: new Date() })
    expect(await requestRegeneration(topicId)).toBeNull()
  })
})

describe('generatePost reuse path', () => {
  it('returns the existing draft and marks the topic USED without calling the LLM', async () => {
    // Early return happens before articleBody() and chatJson(), so nothing touches the network.
    const { topicId, postId } = await newDraft()
    expect(await generatePost(topicId)).toBe(postId)
    const [topic] = await query<{ status: string }>('select status from topics where id = $1', [
      topicId,
    ])
    expect(topic?.status).toBe('USED')
  })
})
