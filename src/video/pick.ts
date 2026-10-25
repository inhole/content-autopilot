import { config } from '../config.ts'
import { query } from '../db/pool.ts'
import { createVideo } from './store.ts'

// Which post becomes the next video (docs/plans/video.md 3-4, 3-8): the published single-source
// Threads post with the most views in the last three weeks that has no video yet.

export const CANDIDATE_WINDOW_DAYS = 21

/** Best candidate post id, or null. Posts without insights come after measured ones, newest first. */
export async function bestCandidate(now = new Date()): Promise<number | null> {
  const [row] = await query<{ id: number }>(
    `select p.id from posts p
     left join lateral (
       select views from post_insights where post_id = p.id order by collected_at desc, id desc limit 1
     ) i on true
     where p.status = 'PUBLISHED' and p.origin in ('news', 'revived')
       and p.published_at >= $1::timestamptz - make_interval(days => $2)
       and p.platform_post_id is not null and p.platform_post_id not like 'dry-%'
       and not exists (select 1 from videos v where v.post_id = p.id)
     order by i.views desc nulls last, p.published_at desc
     limit 1`,
    [now, CANDIDATE_WINDOW_DAYS],
  )
  return row?.id ?? null
}

/** Videos created in the last 7 days (rejected ones too: each one cost a review). */
export async function videosThisWeek(now = new Date()): Promise<number> {
  const [row] = await query<{ n: number }>(
    `select count(*)::int as n from videos
     where origin = 'generated' and created_at >= $1::timestamptz - interval '7 days'`,
    [now],
  )
  return row?.n ?? 0
}

export type PickResult =
  | { kind: 'created'; videoId: number; postId: number }
  | { kind: 'skipped'; reason: string }

/** The automatic pick: respects VIDEO_WEEKLY_MAX, creates at most one video. */
export async function pickVideo(now = new Date()): Promise<PickResult> {
  const made = await videosThisWeek(now)
  if (made >= config.VIDEO_WEEKLY_MAX) {
    return {
      kind: 'skipped',
      reason: `이번 주 영상 ${made}개로 한도(${config.VIDEO_WEEKLY_MAX}) 도달`,
    }
  }
  const postId = await bestCandidate(now)
  if (postId === null) return { kind: 'skipped', reason: '영상으로 만들 발행 글이 없어요' }
  const created = await createVideo(postId)
  if ('created' in created) return { kind: 'created', videoId: created.created, postId }
  // A concurrent pick took the same post; the next run picks another.
  return { kind: 'skipped', reason: `#${postId}는 이미 영상이 있어요` }
}
