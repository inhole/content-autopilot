import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))

const { config } = await import('../src/config.ts')
const { composeChain } = await import('../src/pipeline/parts.ts')
const { DIGEST_RULES, digestUserPrompt } = await import('../src/pipeline/digest-prompts.ts')
const { draftDigest, pickDigestItems, DIGEST_ITEMS } = await import('../src/pipeline/digest.ts')
const { DIGEST_BOT_COMMANDS, DIGEST_HELP_LINES } = await import('../src/pipeline/digest-jobs.ts')

const cand = (postId: number, score: number | null, day: number) => ({
  postId,
  title: `t${postId}`,
  text: `text ${postId}`,
  sourceUrl: `https://example.com/${postId}`,
  score,
  createdAt: new Date(Date.UTC(2026, 9, day)),
})

describe('composeChain with per-part links', () => {
  const base = { text: 'main', topicTag: 'AI', sourceUrl: 'https://example.com/a' }
  const l2 = 'https://example.com/b'
  const l3 = 'https://example.com/c'

  it('gives the main post the source and every follow-up its own link, CTA on the last', () => {
    expect(
      composeChain({
        ...base,
        followups: ['two', 'three'],
        followupLinks: [l2, l3],
        cta: '팔로우',
      }),
    ).toEqual([
      { text: 'main', topicTag: 'AI', linkAttachment: 'https://example.com/a' },
      { text: 'two', linkAttachment: l2 },
      { text: 'three\n\n팔로우', linkAttachment: l3 },
    ])
  })

  it('does not move the source onto the last follow-up, and a missing link stays missing', () => {
    const chain = composeChain({ ...base, followups: ['two', 'three'], followupLinks: [l2, null] })
    expect(chain[2]).not.toHaveProperty('linkAttachment')
    expect(chain[0]?.linkAttachment).toBe(base.sourceUrl)
  })

  it('drops the CTA when it does not fit, links unchanged', () => {
    const long = 'x'.repeat(495)
    const chain = composeChain({
      ...base,
      followups: [long],
      followupLinks: [l2],
      cta: '팔로우해 주세요',
    })
    expect(chain[1]).toEqual({ text: long, linkAttachment: l2 })
  })

  it('behaves as before when no part has a link', () => {
    expect(
      composeChain({ ...base, followups: ['two'], followupLinks: [null], cta: undefined }),
    ).toEqual([
      { text: 'main', topicTag: 'AI' },
      { text: 'two', linkAttachment: base.sourceUrl },
    ])
  })
})

describe('pickDigestItems', () => {
  it('orders by score desc, unscored last, then newest, and caps at DIGEST_ITEMS', () => {
    const picked = pickDigestItems([
      cand(1, 5, 10),
      cand(2, null, 17),
      cand(3, 8, 11),
      cand(4, 5, 14),
      cand(5, 1, 15),
    ])
    expect(DIGEST_ITEMS).toBe(3)
    expect(picked.map((c) => c.postId)).toEqual([3, 4, 1])
  })
})

describe('digest prompt', () => {
  it('numbers the items and carries previous text and feedback on a rewrite', () => {
    const items = [
      { title: 'A', text: '글 A', sourceUrl: 'https://a' },
      { title: 'B', text: '글 B', sourceUrl: null },
    ]
    const first = digestUserPrompt(items)
    expect(first).toContain('답글은 1개')
    expect(first).toContain('소식 2 (답글 1)')
    expect(first).toContain('글 B')
    const again = digestUserPrompt(items, { previous: ['옛 본문', '옛 답글'], feedback: '더 짧게' })
    expect(again).toContain('이전 본 글')
    expect(again).toContain('옛 답글')
    expect(again).toContain('검수자 피드백: 더 짧게')
  })

  it('states the rules the digest depends on', () => {
    expect(DIGEST_RULES).toContain('이번 주 놓친 개발 소식')
    expect(DIGEST_RULES).toContain('속보')
    expect(DIGEST_RULES).toContain('초안에 없는')
    expect(DIGEST_RULES).toContain('URL과 해시태그')
  })
})

describe('draftDigest', () => {
  beforeEach(() => chatJson.mockReset())
  const items = [
    { title: 'A', text: '글 A', sourceUrl: 'https://a' },
    { title: 'B', text: '글 B', sourceUrl: 'https://b' },
  ]
  const raw = (text: string, followups: string[]) => ({
    text,
    followups,
    angle: 'a',
    topic_tag: '개발',
    caveats: [],
  })

  it('rejects a wrong follow-up count', async () => {
    chatJson.mockResolvedValueOnce(raw('가'.repeat(60), []))
    await expect(draftDigest(items)).rejects.toThrow('1 follow-ups')
  })

  it('shortens an over-long last follow-up once to leave room for the CTA', async () => {
    const saved = config.THREAD_CTA_TEXT
    config.THREAD_CTA_TEXT = '팔로우'
    try {
      chatJson
        .mockResolvedValueOnce(raw('가'.repeat(60), ['나'.repeat(498)]))
        .mockResolvedValueOnce({ text: '나'.repeat(300) })
      const gen = await draftDigest(items)
      expect(gen.followups).toEqual(['나'.repeat(300)])
      expect(chatJson).toHaveBeenCalledTimes(2)
      expect(chatJson.mock.calls[0]?.[0].system).toContain(DIGEST_RULES)
    } finally {
      config.THREAD_CTA_TEXT = saved
    }
  })
})

describe('digest bot wiring', () => {
  it('exposes the /digest command and help', () => {
    expect(DIGEST_BOT_COMMANDS[0]?.command).toBe('digest')
    expect(DIGEST_HELP_LINES.join('\n')).toContain('/digest')
  })
})
