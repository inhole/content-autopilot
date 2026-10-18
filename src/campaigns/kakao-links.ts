import { revuCampaignUrl } from './revu-urls.ts'

// Optional scheme and www./m. prefix; the lookbehind rejects look-alike hosts (xrevu.net, a.revu.net).
const REVU_LINK = /(?<![\w.-])(?:https?:\/\/)?(?:(?:www|m)\.)?revu\.net\/campaign\/(\d+)/gi

/** Revu campaign links in free text, canonicalised and deduped by campaign id, in order of appearance. */
export function extractRevuCampaignLinks(text: string): { externalId: string; url: string }[] {
  const found = new Map<string, string>()
  for (const match of text.matchAll(REVU_LINK)) {
    const externalId = match[1] as string
    if (!found.has(externalId)) found.set(externalId, revuCampaignUrl(externalId))
  }
  return [...found].map(([externalId, url]) => ({ externalId, url }))
}
