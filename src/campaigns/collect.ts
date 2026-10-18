import { config } from '../config.ts'
import { type Query, query, transaction } from '../db/pool.ts'
import { hashTranscript, parseKakaoTranscript, readKakaoRoom } from '../kakao/reader.ts'
import { urlHash } from '../lib/url.ts'
import { extractRevuCampaignLinks } from './kakao-links.ts'

/** Adds a revu campaign link as DISCOVERED. Null if the text holds no revu campaign link. */
export async function addCampaignUrl(
  url: string,
  foundIn: string | null = null,
  q: Query = query,
): Promise<{ id: number; created: boolean } | null> {
  const link = extractRevuCampaignLinks(url)[0]
  if (!link) return null

  const [row] = await q<{ id: number }>(
    `insert into campaigns (source, external_id, url, url_hash, found_in, status)
     values ('revu', $1, $2, $3, $4, 'DISCOVERED')
     on conflict do nothing
     returning id`,
    [link.externalId, link.url, urlHash(link.url), foundIn],
  )
  if (row) return { id: row.id, created: true }

  const [existing] = await q<{ id: number }>(
    `select id from campaigns where source = 'revu' and external_id = $1`,
    [link.externalId],
  )
  return existing ? { id: existing.id, created: false } : null
}

export type KakaoCollectResult = {
  room: string
  newMessages: number
  newCampaignIds: number[]
  error?: string
}

/**
 * Reads each KakaoTalk room, records messages not seen before and turns revu links in the new
 * ones into campaigns. One room failing does not stop the others.
 */
export async function collectFromKakao(
  opts: { rooms?: string[]; read?: (room: string) => Promise<string> } = {},
): Promise<KakaoCollectResult[]> {
  const rooms = opts.rooms ?? config.KAKAO_ROOMS
  const read = opts.read ?? readKakaoRoom
  const results: KakaoCollectResult[] = []

  // Rooms are read one at a time: they all drive the same desktop window.
  for (const room of rooms) {
    try {
      results.push(await collectRoom(room, read))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`kakao collect failed for "${room}": ${error}`)
      results.push({ room, newMessages: 0, newCampaignIds: [], error })
    }
  }
  return results
}

async function collectRoom(
  room: string,
  read: (room: string) => Promise<string>,
): Promise<KakaoCollectResult> {
  const messages = parseKakaoTranscript(await read(room))
  const hashes = hashTranscript(room, messages)
  if (messages.length === 0) return { room, newMessages: 0, newCampaignIds: [] }

  // Messages are marked seen in the same transaction as their campaigns are created, so a crash
  // in between either redoes both or neither and no link is lost.
  return transaction(async (q) => {
    const inserted = await q<{ hash: string }>(
      `insert into kakao_messages (hash, room, body)
       select * from unnest($1::text[], $2::text[], $3::text[])
       on conflict do nothing
       returning hash`,
      [hashes, hashes.map(() => room), messages.map((m) => m.body)],
    )
    const fresh = new Set(inserted.map((r) => r.hash))

    const newCampaignIds: number[] = []
    const seenIds = new Set<string>()
    for (const [i, m] of messages.entries()) {
      if (!fresh.has(hashes[i] as string)) continue
      for (const link of extractRevuCampaignLinks(m.body)) {
        if (seenIds.has(link.externalId)) continue
        seenIds.add(link.externalId)
        const added = await addCampaignUrl(link.url, room, q)
        if (added?.created) newCampaignIds.push(added.id)
      }
    }
    return { room, newMessages: fresh.size, newCampaignIds }
  })
}
