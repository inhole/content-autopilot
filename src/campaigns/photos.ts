import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { telegramApi } from './tg.ts'

export function defaultPhotoDir(): string {
  return (
    config.CAMPAIGN_PHOTO_DIR ??
    join(process.env.LOCALAPPDATA ?? tmpdir(), 'content-autopilot', 'photos')
  )
}

/** Downloads a Telegram file by id through the Bot API. */
async function telegramFetchFile(fileId: string): Promise<Buffer> {
  const api = telegramApi()
  if (!api || !config.TELEGRAM_BOT_TOKEN) throw new Error('Telegram is not configured')
  const file = await api.getFile(fileId)
  if (!file.file_path) throw new Error(`Telegram returned no file_path for ${fileId}`)
  const res = await fetch(
    `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    { signal: AbortSignal.timeout(60_000) },
  )
  if (!res.ok) throw new Error(`Telegram file download ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Downloads a campaign's photos to disk (Aside uploads from local files) and returns the paths
 * in idx order. Photos whose local_path still exists are not downloaded again.
 */
export async function downloadPhotos(
  campaignId: number,
  opts: { dir?: string; fetchFile?: (fileId: string) => Promise<Buffer> } = {},
): Promise<string[]> {
  const dir = join(opts.dir ?? defaultPhotoDir(), String(campaignId))
  const fetchFile = opts.fetchFile ?? telegramFetchFile
  const rows = await query<{ idx: number; file_id: string; local_path: string | null }>(
    'select idx, file_id, local_path from campaign_photos where campaign_id = $1 order by idx',
    [campaignId],
  )
  const paths: string[] = []
  for (const row of rows) {
    if (row.local_path && existsSync(row.local_path)) {
      paths.push(row.local_path)
      continue
    }
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${row.idx}.jpg`)
    await writeFile(path, await fetchFile(row.file_id))
    await query('update campaign_photos set local_path = $3 where campaign_id = $1 and idx = $2', [
      campaignId,
      row.idx,
      path,
    ])
    paths.push(path)
  }
  return paths
}
