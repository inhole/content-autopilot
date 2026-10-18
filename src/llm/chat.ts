import { z } from 'zod'
import { config, requireValue } from '../config.ts'

/** An HTTP error from the LLM gateway; `status` decides whether to retry without a schema. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(`${config.LLM_BASE_URL.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireValue('LLM_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  if (!res.ok)
    throw new LlmHttpError(res.status, `LLM ${path} ${res.status}: ${text.slice(0, 500)}`)
  // FreeLLMAPI names the provider/model that actually answered; free routing changes it per call.
  const via = res.headers.get('x-routed-via')
  if (via) console.log(`[llm] routed via ${via}`)
  return JSON.parse(text)
}

const chatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
})

/**
 * Extracts a JSON value from model output. Free models may wrap it in a ```json fence, put a
 * <think> block before it, or add prose around it.
 */
export function extractJson(content: string): unknown {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(candidate)
  } catch (err) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) throw err
    return JSON.parse(candidate.slice(start, end + 1))
  }
}

/** Statuses meaning the request was refused as sent; some providers reject `json_schema`. */
const SCHEMA_REJECTED = new Set([400, 422])

/**
 * Asks the model for JSON matching `schema` and validates it. The schema is sent as a
 * structured-output constraint first; if the provider refuses that, the request is repeated once
 * with the schema in the system prompt instead. Validation never relies on the provider.
 */
export async function chatJson<S extends z.ZodType>(opts: {
  model: string
  system: string
  user: string
  schema: S
  schemaName: string
  temperature?: number
  fetch?: typeof fetch
}): Promise<z.infer<S>> {
  const fetchImpl = opts.fetch ?? fetch
  const jsonSchema = z.toJSONSchema(opts.schema)
  const request = (system: string, constrained: boolean) =>
    post(
      '/chat/completions',
      {
        model: opts.model,
        temperature: opts.temperature ?? 0.7,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: opts.user },
        ],
        ...(constrained && {
          response_format: {
            type: 'json_schema',
            json_schema: { name: opts.schemaName, strict: true, schema: jsonSchema },
          },
        }),
      },
      fetchImpl,
    )

  let raw: unknown
  try {
    raw = await request(opts.system, true)
  } catch (err) {
    if (!(err instanceof LlmHttpError && SCHEMA_REJECTED.has(err.status))) throw err
    console.warn(`[llm] ${opts.schemaName}: structured output refused, retrying with prompt schema`)
    raw = await request(
      `${opts.system}\n\n다른 설명 없이 다음 JSON 스키마에 맞는 JSON 객체 하나만 출력한다.\n${JSON.stringify(jsonSchema)}`,
      false,
    )
  }
  const content = chatResponse.parse(raw).choices[0]?.message.content
  if (!content) throw new Error('LLM returned empty content')
  return opts.schema.parse(extractJson(content))
}
