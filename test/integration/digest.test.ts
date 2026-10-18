import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

const { config } = await import('../../src/config.ts')
const { query } = await import('../../src/db/pool.ts')
const { publishChain } = await import('../../src/pipeline/chain.ts')
const { buildWeeklyDigest, digestPostIdForTopic, loadDigestCandidates, regenerateDigest } =
  await import('../../src/pipeline/digest.ts')
const { loadParts } = await import('../../src/pipeline/parts.ts')
const { publishPost } = await import('../../src/pipeline/publish.ts')
const { requestRegeneration } = await import('../../src/pipeline/generate.ts')
const { FakeThreads } = await import('../fake-threads.ts')
const { seedTopic, seedPost, getPost } = await import('./helpers.ts')

const NOW = new Date('2026-10-18T09:00:00Z')
let n = 0

/** An EXPIRED news draft whose topic has `score`. */
async function expired(
  opts: {
    score?: number | null
    ageDays?: number
    origin?: string
    verdict?: string | null
    revivedAt?: Date | null
    digestOf?: number | null
    status?: string
  } = {},
): Promise<number> {
  n++
  const topicId = await seedTopic({ title: `topic ${n}`, url: `https://example.com/t${n}` })
  await query('update topics set score = $2 where id = $1', [topicId, opts.score ?? 5])
  const postId = await seedPost(topicId, { status: opts.status ?? 'EXPIRED', text: `draft ${n}` })
  await query(
    `update posts set source_url = $2, origin = $3, revive_verdict = $4, revived_at = $5,
       digest_post_id = $6, created_at = $7 where id = $1`,
    [
      postId,
      `https://example.com/src${n}`,
      opts.origin ?? 'news',
      opts.verdict ?? null,
      opts.revivedAt ?? null,
      opts.digestOf ?? null,
      new Date(NOW.getTime() - (opts.ageDays ?? 2) * 86_400_000),
    ],
  )
  return postId
}

const gen = (followups: string[], text = '이번 주 놓친 개발 소식 정리함'.padEnd(80, '가')) => ({
  text,
  followups,
  angle: 'a',
  topic_tag: '개발',
  caveats: [],
})
const piece = (s: string) => s.padEnd(60, '나')

beforeEach(() => {
  chatJson.mockReset()
  n = 0
})

describe('loadDigestCandidates', () => {
  it('keeps only expired, unused, recent, non-evergreen news drafts, best score first', async () => {
    const low = await expired({ score: 3 })
    const high = await expired({ score: 9 })
    const stale = await expired({ score: 6, verdict: 'stale' })
    await expired({ verdict: 'evergreen' })
    await expired({ ageDays: 11 })
    await expired({ origin: 'revived' })
    await expired({ origin: 'digest' })
    await expired({ revivedAt: new Date() })
    await expired({ status: 'REJECTED' })
    const [other] = [await expired({ score: 5 })]
    await expired({ digestOf: other })
    const ids = (await loadDigestCandidates(NOW)).map((c) => c.postId)
    expect(ids).toEqual([high, stale, other, low])
  })
})

describe('buildWeeklyDigest', () => {
  it('returns null with fewer than 2 candidates and writes nothing', async () => {
    await expired()
    expect(await buildWeeklyDigest(NOW)).toBeNull()
    expect(chatJson).not.toHaveBeenCalled()
    const [row] = await query<{ c: number }>('select count(*)::int as c from topics')
    expect(row?.c).toBe(1)
  })

  it('creates topic, post and linked parts and claims the members once', async () => {
    const a = await expired({ score: 9 })
    const b = await expired({ score: 8 })
    const c = await expired({ score: 7 })
    await expired({ score: 1 })
    chatJson.mockResolvedValueOnce(gen([piece('둘'), piece('셋')]))
    const postId = await buildWeeklyDigest(NOW)
    expect(postId).not.toBeNull()

    const [post] = await query<{
      origin: string
      status: string
      source_url: string
      topic_id: number
      generation: { digest: { member_post_ids: number[] } }
    }>('select origin, status, source_url, topic_id, generation from posts where id = $1', [postId])
    expect(post).toMatchObject({
      origin: 'digest',
      status: 'PENDING_REVIEW',
      source_url: 'https://example.com/src1',
    })
    expect(post?.generation.digest.member_post_ids).toEqual([a, b, c])
    const [topic] = await query<{ title: string; url: string | null; status: string }>(
      'select title, url, status from topics where id = $1',
      [post?.topic_id],
    )
    expect(topic).toEqual({ title: '이번 주 놓친 소식 (2026-10-18)', url: null, status: 'USED' })
    expect((await loadParts(postId as number)).map((p) => [p.idx, p.link_url])).toEqual([
      [2, 'https://example.com/src2'],
      [3, 'https://example.com/src3'],
    ])
    const members = await query<{ id: number }>(
      'select id from posts where digest_post_id = $1 order by id',
      [postId],
    )
    expect(members.map((m) => m.id)).toEqual([a, b, c])
    expect(await digestPostIdForTopic(post?.topic_id as number)).toBe(postId)

    // Only the leftover candidate remains, so a second build has nothing to fold.
    expect(await buildWeeklyDigest(NOW)).toBeNull()
  })

  it('builds a one-follow-up digest from 2 candidates', async () => {
    await expired({ score: 9 })
    await expired({ score: 8 })
    chatJson.mockResolvedValueOnce(gen([piece('둘')]))
    const postId = await buildWeeklyDigest(NOW)
    expect(await loadParts(postId as number)).toHaveLength(1)
  })

  it('lets only one of two concurrent builds use the members', async () => {
    await expired({ score: 9 })
    await expired({ score: 8 })
    chatJson.mockResolvedValue(gen([piece('둘')]))
    const results = await Promise.all([buildWeeklyDigest(NOW), buildWeeklyDigest(NOW)])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    const [posts] = await query<{ c: number }>(
      "select count(*)::int as c from posts where origin = 'digest'",
    )
    expect(posts?.c).toBe(1)
    // The losing build rolled back its topic too.
    const [topics] = await query<{ c: number }>(
      "select count(*)::int as c from topics where title like '이번 주 놓친 소식%'",
    )
    expect(topics?.c).toBe(1)
  })
})

describe('regenerateDigest', () => {
  async function built() {
    await expired({ score: 9 })
    await expired({ score: 8 })
    await expired({ score: 7 })
    chatJson.mockResolvedValueOnce(gen([piece('둘'), piece('셋')]))
    const postId = (await buildWeeklyDigest(NOW)) as number
    const [row] = await query<{ topic_id: number }>('select topic_id from posts where id = $1', [
      postId,
    ])
    chatJson.mockClear()
    return { postId, topicId: row?.topic_id as number }
  }

  it('rewrites from the same members with feedback, keeping the part links', async () => {
    const { postId, topicId } = await built()
    const seq = await requestRegeneration(topicId)
    expect(seq).toBe(1)
    chatJson.mockResolvedValueOnce(gen([piece('새 둘'), piece('새 셋')], piece('새 본문')))
    expect(await regenerateDigest(postId, { feedback: '더 짧게', seq: 1 })).toBe(postId)

    const user = (chatJson.mock.calls[0] as [{ user: string }])[0].user
    expect(user).toContain('검수자 피드백: 더 짧게')
    expect(user).toContain('draft 1')
    expect(user).toContain('draft 3')
    const [row] = await query<{ text: string; revision: number; generation: { digest: unknown } }>(
      'select text, revision, generation from posts where id = $1',
      [postId],
    )
    expect(row?.text).toContain('새 본문')
    expect(row?.revision).toBe(2)
    expect(row?.generation.digest).toBeTruthy()
    const parts = await loadParts(postId)
    expect(parts.map((p) => p.text.startsWith('새'))).toEqual([true, true])
    expect(parts.map((p) => p.link_url)).toEqual([
      'https://example.com/src2',
      'https://example.com/src3',
    ])
  })

  it('writes nothing for a stale seq or a post past review', async () => {
    const { postId, topicId } = await built()
    await requestRegeneration(topicId)
    await requestRegeneration(topicId)
    chatJson.mockResolvedValue(gen([piece('새 둘'), piece('새 셋')], piece('새 본문')))
    expect(await regenerateDigest(postId, { seq: 1 })).toBeNull()
    expect((await getPost(postId)).revision).toBe(1)

    await query("update posts set status = 'REJECTED' where id = $1", [postId])
    expect(await regenerateDigest(postId, { seq: 2 })).toBeNull()
    expect(chatJson).toHaveBeenCalledTimes(1) // the rejected post never reached the LLM
  })
})

describe('publishing a digest', () => {
  it('sends the source on the main post and each follow-up with its own link', async () => {
    const saved = config.THREAD_CTA_TEXT
    config.THREAD_CTA_TEXT = '팔로우'
    try {
      await expired({ score: 9 })
      await expired({ score: 8 })
      await expired({ score: 7 })
      chatJson.mockResolvedValueOnce(gen([piece('둘'), piece('셋')]))
      const postId = (await buildWeeklyDigest(NOW)) as number
      await query(
        "update posts set status = 'SCHEDULED', scheduled_at = now() - interval '1 minute' where id = $1",
        [postId],
      )
      const api = new FakeThreads()
      expect((await publishPost(postId, api)).kind).toBe('published')
      expect(await publishChain(postId, api)).toEqual({ kind: 'done', published: 2 })

      expect(api.created.map((c) => c.post.linkAttachment)).toEqual([
        'https://example.com/src1',
        'https://example.com/src2',
        'https://example.com/src3',
      ])
      expect(api.created[2]?.post.text.endsWith('\n\n팔로우')).toBe(true)
    } finally {
      config.THREAD_CTA_TEXT = saved
    }
  })
})
