import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { config } from '../config.ts'

/**
 * The owner's campaign preferences (config/campaign-profile.json). Rule fields (types,
 * excludeKeywords, minRewardWon) are applied in code before the LLM sees a campaign; the rest is
 * prompt context. No address or phone number: revu already has them.
 */
export const campaignProfileSchema = z.object({
  blog: z.object({
    url: z.string(),
    topic: z.string(),
    tone: z.string(),
  }),
  types: z.array(z.enum(['delivery', 'visit', 'other'])).min(1),
  interests: z.array(z.string()),
  excludeKeywords: z.array(z.string()),
  minRewardWon: z.number().int().min(0).default(0),
  applyMessage: z.object({
    maxChars: z.number().int().min(50).max(2000),
    points: z.array(z.string()),
  }),
  /** Put at the very top of every blog review by code, never by the LLM (공정위 심사지침). */
  disclosure: z
    .string()
    .min(1)
    .default('본 포스팅은 레뷰를 통해 제품을 무상으로 제공받아 작성한 솔직한 후기입니다.'),
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
