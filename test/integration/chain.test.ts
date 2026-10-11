import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../../src/config.ts'
import { query } from '../../src/db/pool.ts'
import { dueChainPostIds, publishChain } from '../../src/pipeline/chain.ts'
import { retryFailedParts } from '../../src/pipeline/parts.ts'
import { publishPost } from '../../src/pipeline/publish.ts'
import { FakeThreads } from '../fake-threads.ts'
import { getParts, getPost, seedParts, seedPost, seedTopic } from './helpers.ts'

const SOURCE = 'https://example.com/original'
const CTA = '더 보려면 팔로우'
let originalCta: string | undefined

beforeEach(() => {
  originalCta = config.THREAD_CTA_TEXT
  config.THREAD_CTA_TEXT = CTA
})
afterEach(() => {
  config.THREAD_CTA_TEXT = originalCta
})

/** A PUBLISHED post (main text 'main', media id 'main-id') with PENDING follow-ups. */
async function publishedChain(followups = ['second', 'third'], mainId: string | null = 'main-id') {
  const topicId = await seedTopic({ url: `https://example.com/${Math.random()}` })
  const postId = await seedPost(topicId, { status: 'PUBLISHED', text: 'main' })
  await query('update posts set source_url = $2, platform_post_id = $3 where id = $1', [
    postId,
    SOURCE,
    mainId,
  ])
  await seedParts(postId, followups)
  return postId
}

const lastText = `third\n\n${CTA}`

describe('publishChain', () => {
  it('publishes parts in order, each as a reply to the previous one', async () => {
    const postId = await publishedChain()
    const api = new FakeThreads()
    const outcome = await publishChain(postId, api)
    expect(outcome).toEqual({ kind: 'done', published: 2 })

    const [second, third] = api.created
    expect(second?.post).toMatchObject({ text: 'second', replyToId: 'main-id' })
    expect(second?.post.linkAttachment).toBeFalsy()
    // The link and the CTA go on the last follow-up only.
    expect(third?.post).toMatchObject({ text: lastText, linkAttachment: SOURCE })
    // idx 3 replies to idx 2's media id, which publish returned.
    const parts = await getParts(postId)
    expect(parts.map((p) => p.status)).toEqual(['PUBLISHED', 'PUBLISHED'])
    expect(third?.post.replyToId).toBe(parts[0]?.platform_post_id)
    expect(parts[0]?.platform_post_id).toBeTruthy()
  })

  it('does nothing for a post that is not PUBLISHED', async () => {
    const postId = await publishedChain()
    await query("update posts set status = 'SCHEDULED' where id = $1", [postId])
    const api = new FakeThreads()
    expect(await publishChain(postId, api)).toEqual({ kind: 'skipped' })
    expect(api.created).toHaveLength(0)
  })

  it('publishes each part exactly once under concurrent calls', async () => {
    const postId = await publishedChain()
    const api = new FakeThreads()
    api.createDelayMs = 30
    const outcomes = await Promise.all([
      publishChain(postId, api),
      publishChain(postId, api),
      publishChain(postId, api),
    ])
    // One call won the claim of part 2; the others backed off. Whatever is left is done by the
    // next sweep, which must not repeat anything.
    expect(outcomes.filter((o) => o.kind === 'done')).toHaveLength(1)
    await publishChain(postId, api)
    expect(api.publishCalls).toHaveLength(2)
    expect(api.created.map((c) => c.post.text)).toEqual(['second', lastText])
    expect((await getParts(postId)).map((p) => [p.status, p.claim_seq])).toEqual([
      ['PUBLISHED', 1],
      ['PUBLISHED', 1],
    ])
  })

  it('resumes a stale PUBLISHING part with its saved container', async () => {
    const postId = await publishedChain(['second'])
    const api = new FakeThreads()
    // A crashed worker created and saved a container but never published it.
    const containerId = await api.createTextContainer({ text: lastTextOf('second') })
    await query(
      `update post_parts set status = 'PUBLISHING', container_id = $2, attempts = 1, claim_seq = 1,
         updated_at = now() - interval '11 minutes' where post_id = $1`,
      [postId, containerId],
    )
    expect(await dueChainPostIds()).toEqual([postId])

    expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 1 })
    expect(api.created).toHaveLength(1) // no second container
    expect(api.publishCalls).toEqual([containerId])
    const [part] = await getParts(postId)
    expect(part).toMatchObject({ status: 'PUBLISHED', claim_seq: 2, attempts: 2 })
  })

  it('leaves a fresh PUBLISHING part to its live owner', async () => {
    const postId = await publishedChain(['second'])
    await query(
      "update post_parts set status = 'PUBLISHING', attempts = 1, claim_seq = 1 where post_id = $1",
      [postId],
    )
    const api = new FakeThreads()
    expect(await publishChain(postId, api)).toEqual({ kind: 'skipped' })
    expect(api.created).toHaveLength(0)
    expect(await dueChainPostIds()).toEqual([])
  })

  it('does not publish when the claim is taken over mid-flight', async () => {
    const postId = await publishedChain(['second'])
    const api = new FakeThreads()
    const create = api.createTextContainer.bind(api)
    api.createTextContainer = async (post) => {
      // Simulates the stale-claim sweep handing the part to another worker.
      await query('update post_parts set claim_seq = claim_seq + 1 where post_id = $1', [postId])
      return create(post)
    }
    expect(await publishChain(postId, api)).toEqual({ kind: 'skipped' })
    expect(api.publishCalls).toHaveLength(0)
  })

  it('retries a failed attempt, then marks the part FAILED after 3 attempts', async () => {
    const postId = await publishedChain(['second', 'third'])
    const api = new FakeThreads()
    api.failCreateFor.add('second')

    for (const attempt of [1, 2]) {
      const outcome = await publishChain(postId, api)
      expect(outcome.kind).toBe('retry')
      const [part] = await getParts(postId)
      expect(part).toMatchObject({ status: 'PENDING', attempts: attempt })
      expect(part?.last_error).toMatch(/500/)
    }
    const last = await publishChain(postId, api)
    expect(last).toMatchObject({ kind: 'failed', idx: 2 })
    const parts = await getParts(postId)
    expect(parts.map((p) => p.status)).toEqual(['FAILED', 'PENDING'])
    // The chain stops there: part 3 is never tried and the sweep leaves the post alone.
    expect(parts[1]?.attempts).toBe(0)
    expect(await dueChainPostIds()).toEqual([])
    expect(await publishChain(postId, api)).toEqual({ kind: 'skipped' })

    // The owner's retry button: reset FAILED parts, and the chain completes.
    api.failCreateFor.clear()
    expect(await retryFailedParts(postId)).toBe(1)
    expect(await dueChainPostIds()).toEqual([postId])
    expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 2 })
    expect((await getParts(postId)).map((p) => p.status)).toEqual(['PUBLISHED', 'PUBLISHED'])
    expect(api.created.map((c) => c.post.text)).toEqual(['second', lastText])
  })

  it('recovers a lost publish response from the container and keeps going', async () => {
    const postId = await publishedChain(['second', 'third'])
    const api = new FakeThreads()
    api.loseResponseFor.add('second')

    // publish() threw after Threads published; the re-check sees PUBLISHED and does not retry.
    expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 2 })
    const parts = await getParts(postId)
    expect(parts.map((p) => p.status)).toEqual(['PUBLISHED', 'PUBLISHED'])
    expect(api.publishCalls).toHaveLength(2)
    // The id was unknown when part 3 was attached, so it was found by exact text first.
    const liveSecond = (await api.listMyReplies()).find((r) => r.text === 'second')
    expect(api.created[1]?.post.replyToId).toBe(liveSecond?.id)
    expect(parts[0]?.platform_post_id).toBe(liveSecond?.id)
  })

  it('finds the main post by text when its media id was never saved', async () => {
    const postId = await publishedChain(['second'], null)
    const api = new FakeThreads()
    const liveId = api.addLiveThread('main')
    expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 1 })
    expect(api.created[0]?.post.replyToId).toBe(liveId)
    expect((await query<{ id: string }>('select platform_post_id as id from posts'))[0]?.id).toBe(
      liveId,
    )
  })

  it('counts an unresolvable parent as a failed attempt of the part', async () => {
    const postId = await publishedChain(['second'], null)
    const api = new FakeThreads() // the main post is not in its list
    const outcome = await publishChain(postId, api)
    expect(outcome).toMatchObject({ kind: 'retry' })
    const [part] = await getParts(postId)
    expect(part).toMatchObject({ status: 'PENDING', attempts: 1, container_id: null })
    expect(part?.last_error).toMatch(/cannot resolve/)
    expect(api.created).toHaveLength(0)
  })

  it('stops at the first part that does not end PUBLISHED', async () => {
    const postId = await publishedChain(['second', 'third'])
    const api = new FakeThreads()
    api.failCreateFor.add('second')
    await publishChain(postId, api)
    expect(api.created).toHaveLength(0)
    expect((await getParts(postId)).map((p) => p.status)).toEqual(['PENDING', 'PENDING'])
  })

  it('skips parts that are already PUBLISHED and continues from their id', async () => {
    const postId = await publishedChain(['second', 'third'])
    await query(
      `update post_parts set status = 'PUBLISHED', platform_post_id = 'second-id' where post_id = $1 and idx = 2`,
      [postId],
    )
    const api = new FakeThreads()
    expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 1 })
    expect(api.created).toHaveLength(1)
    expect(api.created[0]?.post.replyToId).toBe('second-id')
  })
})

/** A single follow-up is the last one, so it carries the CTA. */
function lastTextOf(text: string) {
  return `${text}\n\n${CTA}`
}

describe('dueChainPostIds', () => {
  it('picks published posts with pending or abandoned parts only', async () => {
    const pending = await publishedChain(['a'])
    const stale = await publishedChain(['a'])
    await query(
      "update post_parts set status = 'PUBLISHING', updated_at = now() - interval '11 minutes' where post_id = $1",
      [stale],
    )
    const fresh = await publishedChain(['a'])
    await query("update post_parts set status = 'PUBLISHING' where post_id = $1", [fresh])
    const done = await publishedChain(['a'])
    await query("update post_parts set status = 'PUBLISHED' where post_id = $1", [done])
    const failed = await publishedChain(['a'])
    await query("update post_parts set status = 'FAILED' where post_id = $1", [failed])
    const unpublished = await publishedChain(['a'])
    await query("update posts set status = 'SCHEDULED' where id = $1", [unpublished])
    const noParts = await seedPost(await seedTopic({ url: 'https://example.com/np' }), {
      status: 'PUBLISHED',
    })
    expect(noParts).toBeGreaterThan(0)

    expect(await dueChainPostIds()).toEqual([pending, stale])
  })
})

describe('publishPost with parts', () => {
  it('withholds the source link from the main post when follow-ups exist', async () => {
    const withParts = await publishedChain(['a'])
    const single = await publishedChain([])
    for (const id of [withParts, single]) {
      await query(
        "update posts set status = 'SCHEDULED', scheduled_at = now() - interval '1 minute' where id = $1",
        [id],
      )
    }
    const api = new FakeThreads()
    expect((await publishPost(withParts, api)).kind).toBe('published')
    expect((await publishPost(single, api)).kind).toBe('published')

    expect(api.created[0]?.post.linkAttachment).toBeFalsy()
    expect(api.created[1]?.post.linkAttachment).toBe(SOURCE)
    expect((await getPost(withParts)).status).toBe('PUBLISHED')
  })
})
