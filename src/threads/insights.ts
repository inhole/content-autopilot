import { z } from 'zod'

export const INSIGHT_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'] as const

export type Insights = { [K in (typeof INSIGHT_METRICS)[number]]: number | null }

const metricSchema = z.object({
  name: z.string(),
  values: z.array(z.object({ value: z.number() })).optional(),
  total_value: z.object({ value: z.number() }).optional(),
})
const insightsResponse = z.object({ data: z.array(metricSchema) })

export const emptyInsights = (): Insights => ({
  views: null,
  likes: null,
  replies: null,
  reposts: null,
  quotes: null,
  shares: null,
})

/**
 * Maps a media-insights response to numbers. Metrics arrive either as `values: [{ value }]` or as
 * `total_value: { value }`; a metric Threads leaves out stays null.
 */
export function parseInsights(json: unknown): Insights {
  const parsed = insightsResponse.safeParse(json)
  if (!parsed.success) throw new Error(`unexpected insights response: ${parsed.error.message}`)
  const out = emptyInsights()
  for (const m of parsed.data.data) {
    if (!(INSIGHT_METRICS as readonly string[]).includes(m.name)) continue
    const value = m.total_value?.value ?? m.values?.[0]?.value
    if (value !== undefined) out[m.name as keyof Insights] = value
  }
  return out
}
