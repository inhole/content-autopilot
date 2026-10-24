import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'

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

let cachedFile: CampaignProfile | undefined

export function parseCampaignProfile(json: unknown): CampaignProfile {
  return campaignProfileSchema.parse(json)
}

async function loadFileProfile(path: string): Promise<CampaignProfile> {
  if (cachedFile) return cachedFile
  const text = await readFile(resolve(path), 'utf8')
  cachedFile = parseCampaignProfile(JSON.parse(text))
  return cachedFile
}

export type ProfileInEffect = {
  profile: CampaignProfile
  source: 'db' | 'file'
  /** Edit guard: the saved row's revision, 0 while no row exists. */
  revision: number
}

/**
 * The profile in effect. The saved copy (table `campaign_profile`) is re-read on every call, so an
 * edit applies from the next ranking run or review draft without a restart; the file is read once
 * per process. A saved copy that no longer matches the schema is logged and ignored (the file
 * applies), and keeps its row revision so the page can save over it.
 */
export async function loadProfileInEffect(
  path = config.CAMPAIGN_PROFILE_PATH,
): Promise<ProfileInEffect> {
  const [row] = await query<{ profile: unknown; revision: number }>(
    'select profile, revision from campaign_profile where id = 1',
  )
  if (row) {
    const parsed = campaignProfileSchema.safeParse(row.profile)
    if (parsed.success) return { profile: parsed.data, source: 'db', revision: row.revision }
    console.error(
      '[profile] saved campaign profile is invalid; using the file:',
      parsed.error.message,
    )
    return { profile: await loadFileProfile(path), source: 'file', revision: row.revision }
  }
  return { profile: await loadFileProfile(path), source: 'file', revision: 0 }
}

export async function loadCampaignProfile(
  path = config.CAMPAIGN_PROFILE_PATH,
): Promise<CampaignProfile> {
  return (await loadProfileInEffect(path)).profile
}

/**
 * Saves the profile if `revision` is the one the caller saw: 0 = no saved copy yet (inserts only
 * while no row exists, giving revision 1), n > 0 = updates the row at revision n to n + 1.
 * Returns the new revision, or null when the revision is stale.
 */
export async function saveCampaignProfile(
  profile: CampaignProfile,
  revision: number,
): Promise<number | null> {
  const json = JSON.stringify(profile)
  const rows =
    revision === 0
      ? await query<{ revision: number }>(
          `insert into campaign_profile (id, profile, revision) values (1, $1::jsonb, 1)
           on conflict (id) do nothing returning revision`,
          [json],
        )
      : await query<{ revision: number }>(
          `update campaign_profile set profile = $1::jsonb, revision = revision + 1, updated_at = now()
            where id = 1 and revision = $2 returning revision`,
          [json, revision],
        )
  return rows[0]?.revision ?? null
}

/**
 * Deletes the saved copy so the file applies again. True when done; false when `revision` is
 * stale. Revision 0 means the page showed the file: nothing to delete, so true while there still
 * is no row, false if someone saved one meanwhile (the page should refetch).
 */
export async function resetCampaignProfile(revision: number): Promise<boolean> {
  if (revision === 0) {
    const rows = await query('select 1 from campaign_profile where id = 1')
    return rows.length === 0
  }
  const rows = await query(
    'delete from campaign_profile where id = 1 and revision = $1 returning id',
    [revision],
  )
  return rows.length > 0
}
