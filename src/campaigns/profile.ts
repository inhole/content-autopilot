import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { config } from '../config.ts'

/**
 * The owner's campaign preferences (config/campaign-profile.json). Rule fields (excludeKeywords,
 * excludeBrands, maxCompetition, minPriceWon) are applied in code before scoring; interests and
 * preferKeywords also feed the rule score. No address or phone number: Kakao already has them.
 */
export const campaignProfileSchema = z.object({
  /** Who the owner is, in a sentence or two; context for ranking and review drafts. */
  about: z.string(),
  interests: z.array(z.string()),
  /** Words in a title, brand or Musinsa category that earn the rule score's preference points. */
  preferKeywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()),
  excludeBrands: z.array(z.string()).default([]),
  /** Skip campaigns with more applicants per slot than this. Unset: no limit. */
  maxCompetition: z.number().positive().optional(),
  /** Skip campaigns whose known list price (won) is below this. Unknown price is not skipped. */
  minPriceWon: z.number().int().positive().optional(),
  review: z.object({
    tone: z.string(),
    minChars: z.number().int().min(10).default(100),
    // The draft is sent as one Telegram message (4096 chars), so stay below that.
    maxChars: z.number().int().min(50).max(4000).default(500),
    points: z.array(z.string()).default([]),
  }),
  /** Put first in every review draft by code, never by the LLM. Unset: no line is added. */
  disclosure: z.string().min(1).optional(),
})
export type CampaignProfile = z.infer<typeof campaignProfileSchema>

let cached: CampaignProfile | undefined

export function parseCampaignProfile(json: unknown): CampaignProfile {
  return campaignProfileSchema.parse(json)
}

export async function loadCampaignProfile(
  path = config.CAMPAIGN_PROFILE_PATH,
): Promise<CampaignProfile> {
  if (cached) return cached
  const text = await readFile(resolve(path), 'utf8')
  cached = parseCampaignProfile(JSON.parse(text))
  return cached
}
