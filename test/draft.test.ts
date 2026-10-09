import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.fn()
vi.mock('../src/llm/openrouter.ts', () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }))

const { draftPost } = await import('../src/pipeline/generate.ts')

const draft = (text: string) => ({ text, angle: 'a', topic_tag: 'AI', caveats: [] })

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
