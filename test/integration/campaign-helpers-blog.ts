import type { Campaign, CampaignDetail, CampaignStatus } from '../../src/campaigns/types.ts'
import { query } from '../../src/db/pool.ts'

export const TEST_DETAIL: CampaignDetail = {
  title: '무선 이어폰 체험단',
  type: 'delivery',
  category: '디지털',
  offer: '무선 이어폰 1개',
  rewardWon: 59000,
  recruitCount: 5,
  applyDeadline: null,
  announceAt: null,
  reviewDeadline: null,
  channel: '네이버 블로그',
  keywords: ['무선이어폰', '노이즈캔슬링'],
  guide: '사진 5장 이상, 1,500자 이상',
  applyQuestions: [],
}

let counter = 0

export async function seedBlogCampaign(
  opts: {
    status?: CampaignStatus
    memo?: string | null
    draftTitle?: string | null
    draftBody?: string | null
    revision?: number
    reviewMessageId?: number | null
    attempts?: number
    keywords?: string[]
    updatedAgoMinutes?: number
  } = {},
): Promise<number> {
  counter++
  const detail = { ...TEST_DETAIL, keywords: opts.keywords ?? TEST_DETAIL.keywords }
  const [row] = await query<{ id: number }>(
    `insert into campaigns (external_id, url, url_hash, status, title, detail, keywords, memo,
                            draft_title, draft_body, revision, review_message_id, review_revision,
                            attempts, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $13,
             now() - make_interval(mins => $14))
     returning id`,
    [
      `ext-${counter}`,
      `https://revu.net/campaign/${counter}`,
      `hash-${counter}`,
      opts.status ?? 'SELECTED',
      detail.title,
      JSON.stringify(detail),
      detail.keywords,
      opts.memo ?? null,
      opts.draftTitle ?? null,
      opts.draftBody ?? null,
      opts.revision ?? 0,
      opts.reviewMessageId ?? null,
      opts.attempts ?? 0,
      opts.updatedAgoMinutes ?? 0,
    ],
  )
  if (!row) throw new Error('seedBlogCampaign failed')
  return row.id
}

export async function getCampaign(id: number) {
  const [row] = await query<Campaign>('select * from campaigns where id = $1', [id])
  if (!row) throw new Error(`campaign ${id} not found`)
  return row
}

export async function seedPhotos(campaignId: number, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await query(
      'insert into campaign_photos (campaign_id, idx, file_id, file_unique_id) values ($1, $2, $3, $4)',
      [campaignId, i, `file-${i}`, `uniq-${i}`],
    )
  }
}

export async function getPhotos(campaignId: number) {
  return query<{ idx: number; file_id: string; file_unique_id: string; local_path: string | null }>(
    'select idx, file_id, file_unique_id, local_path from campaign_photos where campaign_id = $1 order by idx',
    [campaignId],
  )
}
