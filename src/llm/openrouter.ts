import { z } from 'zod'
import { requireValue } from '../config.ts'

const BASE = 'https://openrouter.ai/api/v1'

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireValue('OPENROUTER_API_KEY')}`,
      'Content-Type': 'application/json',
      'X-Title': 'content-autopilot',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenRouter ${path} ${res.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

const chatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
})

/** Extracts a JSON value from model output that may be wrapped in a ```json fence. */
export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  return JSON.parse((fenced?.[1] ?? content).trim())
}

/**
 * Asks the model for JSON matching `schema` and validates it. The schema is also sent as a
 * structured-output constraint, but validation never relies on the provider honoring it.
 */
export async function chatJson<S extends z.ZodType>(opts: {
  model: string
  system: string
  user: string
  schema: S
  schemaName: string
  temperature?: number
}): Promise<z.infer<S>> {
  const raw = await post('/chat/completions', {
    model: opts.model,
    temperature: opts.temperature ?? 0.7,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, strict: true, schema: z.toJSONSchema(opts.schema) },
    },
  })
  const content = chatResponse.parse(raw).choices[0]?.message.content
  if (!content) throw new Error('LLM returned empty content')
  return opts.schema.parse(extractJson(content))
}

const embeddingResponse = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
})

export async function embed(model: string, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return []
  const raw = embeddingResponse.parse(await post('/embeddings', { model, input: inputs }))
  return raw.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
