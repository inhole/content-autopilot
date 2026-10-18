import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.LLM_API_KEY = 'freellmapi-test'
process.env.LLM_BASE_URL = 'http://gateway.test/v1/'

const { chatJson, extractJson } = await import('../src/llm/chat.ts')
const { z } = await import('zod')

const schema = z.object({ text: z.string() })

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'x-routed-via': 'groq/llama-3.3-70b' },
  })

describe('extractJson', () => {
  it('reads plain, fenced, think-prefixed and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('<think>{"no":0} 고민 중</think>\n{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('결과는 다음과 같다.\n{"a":{"b":2}}\n끝')).toEqual({ a: { b: 2 } })
  })
  it('throws when there is no JSON object', () => {
    expect(() => extractJson('없음')).toThrow()
  })
})

describe('chatJson', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const call = () =>
    chatJson({
      model: 'auto:smart',
      system: 'sys',
      user: 'u',
      schema,
      schemaName: 's',
      fetch: fetchMock,
    })
  const body = (i: number) => JSON.parse(String(fetchMock.mock.calls[i]?.[1]?.body))

  beforeEach(() => {
    fetchMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends the schema as structured output to the configured gateway', async () => {
    fetchMock.mockResolvedValueOnce(completion('{"text":"안녕"}'))
    expect(await call()).toEqual({ text: '안녕' })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('http://gateway.test/v1/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer freellmapi-test' })
    expect(body(0).model).toBe('auto:smart')
    expect(body(0).response_format.json_schema.name).toBe('s')
  })

  it('retries once with the schema in the prompt when structured output is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('json_schema not supported', { status: 400 }))
      .mockResolvedValueOnce(completion('```json\n{"text":"b"}\n```'))
    expect(await call()).toEqual({ text: 'b' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body(1).response_format).toBeUndefined()
    expect(body(1).messages[0].content).toContain('"text"')
  })

  it('does not retry other failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quota', { status: 429 }))
    await expect(call()).rejects.toThrow('429')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects output that does not match the schema', async () => {
    fetchMock.mockResolvedValueOnce(completion('{"other":1}'))
    await expect(call()).rejects.toThrow()
  })
})
