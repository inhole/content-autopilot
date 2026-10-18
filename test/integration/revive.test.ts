import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.hoisted(() => vi.fn())
vi.mock('../../src/llm/openrouter.ts', () => ({ chatJson }))

import { query } from '../../src/db/pool.ts'
import { judgeExpired, loadRevivable, reviveDraft } from '../../src/pipeline/revive.ts'
import { getParts, seedParts, seedPost, seedTopic } from './helpers.ts'

const now = new Date()
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

async function expired(opts: { text?: string; created?: Date; title?: string } = {}) {
  const id = await seedPost(await seedTopic({ title: opts.title ?? 't', url: null }), {
    status: 'EXPIRED',
    text: opts.text ?? '오늘 나왔음\n이건 변하지 않는 얘기임',
  })
  await query('update posts set created_at = $2 where id = $1', [id, opts.created ?? daysAgo(5)])
  return id
}

const row = async (id: number) =>
  (
    await query<{
      status: string
      text: string
      origin: string
      revision: number
      revived_at: Date | null
      review_message_id: number | null
      generation: { text: string; revived?: { from_text: string; changes: string[] } } | null
      revive_verdict: string | null
      revive_checked_at: Date | null
    }>(
      `select status, text, origin, revision, revived_at, review_message_id, generation,
              revive_verdict, revive_checked_at from posts where id = $1`,
      [id],
    )
  )[0]

beforeEach(() => chatJson.mockReset())

describe('loadRevivable', () => {
  it('applies the window and status/origin/revived/digest filters, newest first', async () => {
    const recent = await expired({ created: daysAgo(2) })
    const older = await expired({ created: daysAgo(10) })
    await expired({ created: daysAgo(31) })
    const pending = await seedPost(await seedTopic({ url: null }), { status: 'PENDING_REVIEW' })
    const revived = await expired()
    await query('update posts set revived_at = now() where id = $1', [revived])
    const digested = await expired()
    await query('update posts set digest_post_id = $2 where id = $1', [digested, recent])
    const digestOrigin = await expired()
    await query("update posts set origin = 'digest' where id = $1", [digestOrigin])

    const ids = (await loadRevivable(now)).map((p) => p.id)
    expect(ids).toEqual([recent, older])
    expect(ids).not.toContain(pending)
  })

  it('returns at most 20', async () => {
    for (let i = 0; i < 22; i++) await expired()
    expect(await loadRevivable(now)).toHaveLength(20)
  })
})

describe('judgeExpired', () => {
  it('saves verdicts, skips checked posts and leaves skipped ids unchecked', async () => {
    const a = await expired({ title: 'a' })
    const b = await expired({ title: 'b' })
    const c = await expired({ title: 'c' })
    chatJson.mockResolvedValueOnce({
      verdicts: [
        { id: a, verdict: 'evergreen', reason: '노하우' },
        { id: b, verdict: 'stale', reason: '출시 소식' },
        { id: 9999, verdict: 'stale', reason: 'unknown' },
      ],
    })
    const first = await judgeExpired(now)
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(chatJson.mock.calls[0]?.[0]).toMatchObject({ temperature: 0 })
    expect(first.find((p) => p.id === a)?.verdict).toBe('evergreen')
    expect(first.find((p) => p.id === c)?.verdict).toBeNull()
    expect((await row(a))?.revive_verdict).toBe('evergreen')
    expect((await row(c))?.revive_checked_at).toBeNull()

    // Only the unchecked post is asked about the second time.
    chatJson.mockResolvedValueOnce({ verdicts: [{ id: c, verdict: 'stale', reason: 'x' }] })
    await judgeExpired(now)
    const user = chatJson.mock.calls[1]?.[0].user as string
    expect(user).toContain(`[id ${c}]`)
    expect(user).not.toContain(`[id ${a}]`)

    // Everything checked: no further call.
    await judgeExpired(now)
    expect(chatJson).toHaveBeenCalledTimes(2)
  })
})

describe('reviveDraft', () => {
  it('moves an expired draft back to review with the rewritten text', async () => {
    const id = await expired({ text: '오늘 나왔음\n핵심은 이거임' })
    await seedParts(id, ['후속 답글'])
    await query('update posts set generation = $2::jsonb, review_message_id = 7 where id = $1', [
      id,
      JSON.stringify({ text: '오늘 나왔음\n핵심은 이거임', angle: 'a' }),
    ])
    const before = { revision: (await row(id))?.revision ?? -1 }
    chatJson.mockResolvedValueOnce({ text: '핵심은 이거임', changes: ['"오늘 나왔음" 삭제'] })

    expect(await reviveDraft(id, now)).toBe(true)
    const system = chatJson.mock.calls[0]?.[0].system as string
    expect(system).toContain('음슴체')
    const r = await row(id)
    expect(r).toMatchObject({
      status: 'PENDING_REVIEW',
      text: '핵심은 이거임',
      origin: 'revived',
      revision: before.revision + 1,
      review_message_id: null,
    })
    expect(r?.revived_at).not.toBeNull()
    // generation.text equals text, so style learning does not see an owner edit.
    expect(r?.generation?.text).toBe(r?.text)
    expect(r?.generation?.revived?.from_text).toBe('오늘 나왔음\n핵심은 이거임')
    expect(r?.generation?.revived?.changes).toEqual(['"오늘 나왔음" 삭제'])
    const parts = await getParts(id)
    expect(parts.map((p) => p.idx)).toEqual([2])
  })

  it('shortens once when the rewrite exceeds the Threads limit', async () => {
    const id = await expired()
    chatJson
      .mockResolvedValueOnce({ text: '가'.repeat(600), changes: [] })
      .mockResolvedValueOnce({ text: '나'.repeat(400) })
    expect(await reviveDraft(id, now)).toBe(true)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect((await row(id))?.text).toBe('나'.repeat(400))
  })

  it('does not revive twice', async () => {
    const id = await expired()
    chatJson.mockResolvedValue({ text: '다시 쓴 글', changes: [] })
    expect(await reviveDraft(id, now)).toBe(true)
    await query("update posts set status = 'EXPIRED' where id = $1", [id])
    chatJson.mockClear()
    expect(await reviveDraft(id, now)).toBe(false)
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('refuses digested and non-expired posts', async () => {
    const digested = await expired()
    const other = await expired()
    await query('update posts set digest_post_id = $2 where id = $1', [digested, other])
    const pending = await seedPost(await seedTopic({ url: null }), { status: 'PENDING_REVIEW' })
    chatJson.mockResolvedValue({ text: '다시 쓴 글', changes: [] })
    expect(await reviveDraft(digested, now)).toBe(false)
    expect(await reviveDraft(pending, now)).toBe(false)
    expect((await row(digested))?.status).toBe('EXPIRED')
  })

  it('loses the race when the post is revived while the LLM runs', async () => {
    const id = await expired()
    chatJson.mockImplementationOnce(async () => {
      await query('update posts set revived_at = now() where id = $1', [id])
      return { text: '다시 쓴 글', changes: [] }
    })
    expect(await reviveDraft(id, now)).toBe(false)
    expect((await row(id))?.status).toBe('EXPIRED')
  })
})
