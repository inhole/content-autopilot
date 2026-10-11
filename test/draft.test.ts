import { beforeEach, describe, expect, it, vi } from 'vitest'

// The last follow-up's limit depends on the CTA length; set it before config loads.
process.env.THREAD_CTA_TEXT = '팔로우하면 다음 소식도 받아볼 수 있어요'

const chatJson = vi.fn()
vi.mock('../src/llm/openrouter.ts', () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }))

const { draftPost, generationSchema } = await import('../src/pipeline/generate.ts')
const { lastFollowupLimit, MAX_FOLLOWUPS } = await import('../src/pipeline/parts.ts')
const { z } = await import('zod')

const draft = (text: string, followups: string[] = []) => ({
  text,
  followups,
  angle: 'a',
  topic_tag: 'AI',
  caveats: [],
})

describe('draftPost', () => {
  beforeEach(() => chatJson.mockReset())

  it('returns a draft within the limit as-is', async () => {
    chatJson.mockResolvedValueOnce(draft('가'.repeat(400)))
    const out = await draftPost('user')
    expect(out.text).toHaveLength(400)
    expect(chatJson).toHaveBeenCalledOnce()
  })

  it('shortens an over-limit draft once and keeps the other fields', async () => {
    chatJson
      .mockResolvedValueOnce({ ...draft('가'.repeat(520)), caveats: ['x'] })
      .mockResolvedValueOnce({ text: '나'.repeat(440) })
    const out = await draftPost('user', 'some/model')
    expect(out.text).toBe('나'.repeat(440))
    expect(out.caveats).toEqual(['x'])
    expect(chatJson).toHaveBeenCalledTimes(2)
    const second = chatJson.mock.calls[1]?.[0] as { model: string; user: string }
    expect(second.model).toBe('some/model')
    expect(second.user).toContain('가'.repeat(520))
  })
})

describe('draftPost chain', () => {
  beforeEach(() => chatJson.mockReset())
  const schemaKeys = (call: number) =>
    Object.keys(
      (z.toJSONSchema(chatJson.mock.calls[call]?.[0].schema) as { properties: object }).properties,
    )

  it('asks for follow-ups only when the chain is enabled', async () => {
    chatJson.mockResolvedValueOnce(draft('가'.repeat(300)))
    const off = await draftPost('user', 'm', false)
    expect(off.followups).toEqual([])
    expect(schemaKeys(0)).not.toContain('followups')
    expect(chatJson.mock.calls[0]?.[0].system).not.toContain('followups')

    chatJson.mockResolvedValueOnce(draft('가'.repeat(300), ['나'.repeat(100)]))
    const on = await draftPost('user', 'm', true)
    expect(on.followups).toEqual(['나'.repeat(100)])
    expect(schemaKeys(1)).toContain('followups')
    expect(chatJson.mock.calls[1]?.[0].system).toContain('followups')
  })

  it('drops empty follow-ups and caps the count', async () => {
    chatJson.mockResolvedValueOnce(
      draft('가'.repeat(300), ['  ', '나'.repeat(60), '다'.repeat(60), '라'.repeat(60)]),
    )
    const out = await draftPost('user', 'm', true)
    expect(out.followups).toEqual(['나'.repeat(60), '다'.repeat(60)])
    expect(out.followups.length).toBeLessThanOrEqual(MAX_FOLLOWUPS)
    expect(generationSchema.safeParse({ ...out, followups: ['a', 'b', 'c'] }).success).toBe(false)
  })

  it('shortens each piece against its own limit', async () => {
    const last = lastFollowupLimit()
    // 480 fits a middle follow-up but not the last one, which must leave room for the CTA.
    const mid = '나'.repeat(480)
    const tail = '다'.repeat(480)
    chatJson
      .mockResolvedValueOnce(draft('가'.repeat(520), [mid, tail]))
      .mockResolvedValueOnce({ text: '가'.repeat(440) })
      .mockResolvedValueOnce({ text: '다'.repeat(last - 10) })
    const out = await draftPost('user', 'm', true)
    expect(chatJson).toHaveBeenCalledTimes(3)
    expect(out.text).toBe('가'.repeat(440))
    expect(out.followups[0]).toBe(mid)
    expect(out.followups[1]).toBe('다'.repeat(last - 10))
    const lastCall = chatJson.mock.calls[2]?.[0] as { user: string }
    expect(lastCall.user).toContain(tail)
    expect(lastCall.user).toContain(`${last - 50}자 이내`)
  })
})
