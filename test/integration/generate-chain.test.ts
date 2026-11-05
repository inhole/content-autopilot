import { beforeEach, describe, expect, it, vi } from 'vitest'

// The format experiment decides chain vs single when a caller passes no `chain`; set before config loads.
process.env.THREAD_CHAIN_MODE = 'alternate'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))
vi.mock('../../src/pipeline/sources.ts', () => ({
  gatherSources: async () => ({
    sourceUrl: 'https://example.com/a',
    body: 'article body',
    aux: [],
  }),
}))
vi.mock('../../src/pipeline/style.ts', () => ({
  loadStyleContext: async () => ({}),
  buildStylePrompt: () => '',
}))

const { query } = await import('../../src/db/pool.ts')
const { generatePost, requestRegeneration } = await import('../../src/pipeline/generate.ts')
const { loadParts } = await import('../../src/pipeline/parts.ts')
const { seedTopic, seedPost, getPost } = await import('./helpers.ts')

const draft = (text: string, followups: string[]) => ({
  text,
  followups,
  angle: 'a',
  topic_tag: 'AI',
  caveats: [],
})
const main = '가'.repeat(120)

describe('generatePost with follow-ups', () => {
  beforeEach(() => chatJson.mockReset())

  it('stores the post and its parts together, and a regeneration replaces them', async () => {
    const topicId = await seedTopic()
    chatJson.mockResolvedValueOnce(draft(main, ['첫 답글'.repeat(20), '둘째 답글'.repeat(20)]))
    const postId = await generatePost(topicId, { chain: true })
    expect(postId).not.toBeNull()
    const parts = await loadParts(postId as number)
    expect(parts.map((p) => p.idx)).toEqual([2, 3])
    expect(parts[0]?.text).toContain('첫 답글')
    const [stored] = await query<{ v: string | null }>(
      "select generation->>'prompt_version' as v from posts where id = $1",
      [postId],
    )
    expect(stored?.v).toBe('2')

    const seq = await requestRegeneration(topicId)
    chatJson.mockResolvedValueOnce(draft(`${main}!`, ['새 답글'.repeat(20)]))
    await generatePost(topicId, {
      chain: true,
      regenerate: true,
      feedback: '더 짧게',
      ...(seq === null ? {} : { seq }),
    })
    expect((await loadParts(postId as number)).map((p) => p.text)).toEqual(['새 답글'.repeat(20)])
    expect((await getPost(postId as number)).revision).toBe(2)
    // The revision prompt carries the previous follow-ups.
    const user = (chatJson.mock.calls[1] as [{ user: string }])[0].user
    expect(user).toContain('이전 답글 1')
    expect(user).toContain('둘째 답글')

    // A regeneration without follow-ups clears the old ones.
    chatJson.mockResolvedValueOnce(draft(`${main}?`, []))
    await generatePost(topicId, { chain: true, regenerate: true })
    expect(await loadParts(postId as number)).toEqual([])
  })

  it('writes no parts when the post write is dropped', async () => {
    const topicId = await seedTopic()
    const postId = await seedPost(topicId)
    await query('update posts set regen_seq = 5 where id = $1', [postId])
    chatJson.mockResolvedValueOnce(draft(main, ['낡은 답글'.repeat(20)]))
    // Stale seq: the conditional update returns no row, so nothing may be written.
    expect(await generatePost(topicId, { chain: true, regenerate: true, seq: 4 })).toBeNull()
    expect(await loadParts(postId)).toEqual([])
  })

  it('stores no parts when the chain is disabled', async () => {
    const topicId = await seedTopic()
    chatJson.mockResolvedValueOnce({ text: main, angle: 'a', topic_tag: 'AI', caveats: [] })
    const postId = await generatePost(topicId, { chain: false })
    expect(await loadParts(postId as number)).toEqual([])
  })
})

describe('generatePost format experiment', () => {
  beforeEach(() => chatJson.mockReset())

  it('asks for follow-ups on even topic ids only, also on regeneration', async () => {
    const ids = [await seedTopic(), await seedTopic()]
    const schemaNames = () =>
      chatJson.mock.calls.map((c) => (c as [{ schemaName: string }])[0].schemaName)
    const expected = ids.map((id) => (id % 2 === 0 ? 'threads_chain' : 'threads_post'))

    for (const topicId of ids) {
      chatJson.mockResolvedValueOnce(draft(main, topicId % 2 === 0 ? ['답글'.repeat(20)] : []))
      await generatePost(topicId)
    }
    expect(schemaNames()).toEqual(expected)

    chatJson.mockReset()
    for (const topicId of ids) {
      chatJson.mockResolvedValueOnce(
        draft(`${main}!`, topicId % 2 === 0 ? ['새 답글'.repeat(20)] : []),
      )
      await generatePost(topicId, { regenerate: true })
    }
    expect(schemaNames()).toEqual(expected)
  })
})
