import { query } from '../db/pool.ts'
import { getInstagramApi, getYouTubeApi } from './accounts.ts'
import type { InstagramApi, VideoMetrics } from './instagram.ts'
import { PLATFORM_LABELS, type Platform } from './types.ts'
import type { YouTubeApi } from './youtube.ts'

// Video insights (docs/plans/video.md 3-12): one snapshot per publication per day, and a section
// for the weekly report that uses only the latest snapshot of each publication.

const COLLECT_WINDOW_DAYS = 30
const REPORT_WINDOW_DAYS = 7
const TITLE_PREVIEW = 24

export async function collectVideoInsights(
  now = new Date(),
  deps: { instagram?: InstagramApi; youtube?: YouTubeApi } = {},
): Promise<{ collected: number; empty: number; failed: number }> {
  const pubs = await query<{ id: number; platform: Platform; platform_media_id: string }>(
    `select id, platform, platform_media_id from video_publications
     where status = 'PUBLISHED' and platform_media_id is not null
       and platform_media_id not like 'dry-%'
       and published_at >= $1::timestamptz - make_interval(days => $2)
     order by id`,
    [now, COLLECT_WINDOW_DAYS],
  )
  const result = { collected: 0, empty: 0, failed: 0 }
  if (pubs.length === 0) return result
  let instagram = deps.instagram
  let youtube = deps.youtube
  for (const p of pubs) {
    try {
      let m: VideoMetrics | null
      if (p.platform === 'REELS') {
        instagram ??= await getInstagramApi()
        m = await instagram.getInsights(p.platform_media_id)
      } else {
        youtube ??= await getYouTubeApi()
        m = await youtube.statistics(p.platform_media_id)
      }
      // An all-unknown snapshot would hide the last real numbers from the report.
      if (!m || Object.values(m).every((v) => v === null)) {
        result.empty++
        continue
      }
      await query(
        `insert into video_insights (publication_id, views, likes, comments, shares, saves)
         values ($1, $2, $3, $4, $5, $6)`,
        [p.id, m.views, m.likes, m.comments, m.shares, m.saves],
      )
      result.collected++
    } catch (err) {
      console.error(`[video-insights] publication ${p.id} failed: ${(err as Error).message}`)
      result.failed++
    }
  }
  return result
}

export type VideoReportRow = {
  platform: Platform
  title: string
  views: number | null
  likes: number | null
}

export async function loadVideoReportRows(now = new Date()): Promise<VideoReportRow[]> {
  return query<VideoReportRow>(
    `select p.platform, coalesce(v.title, '') as title, i.views, i.likes
     from video_publications p
     join videos v on v.id = p.video_id
     left join lateral (
       select views, likes from video_insights where publication_id = p.id
       order by collected_at desc, id desc limit 1
     ) i on true
     where p.status = 'PUBLISHED' and p.platform_media_id not like 'dry-%'
       and p.published_at >= $1::timestamptz - make_interval(days => $2)
     order by p.published_at`,
    [now, REPORT_WINDOW_DAYS],
  )
}

const preview = (t: string) =>
  [...t].length > TITLE_PREVIEW ? `${[...t].slice(0, TITLE_PREVIEW).join('')}…` : t

/** Lines appended to the weekly report; empty when no video went out this week. */
export function buildVideoReport(rows: VideoReportRow[]): string[] {
  if (rows.length === 0) return []
  const out = ['', '🎬 영상 (최근 7일)']
  for (const platform of ['REELS', 'SHORTS'] as Platform[]) {
    const rs = rows.filter((r) => r.platform === platform)
    if (rs.length === 0) continue
    const measured = rs.filter((r) => r.views !== null)
    const views = measured.reduce((n, r) => n + (r.views ?? 0), 0)
    out.push(
      `${PLATFORM_LABELS[platform]} ${rs.length}개 — 조회 ${measured.length ? views : '-'}` +
        (measured.length < rs.length ? ` (집계 ${measured.length}개)` : ''),
    )
  }
  const top = rows
    .filter((r) => r.views !== null)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0]
  if (top)
    out.push(
      `가장 많이 본 영상: "${preview(top.title)}" (${PLATFORM_LABELS[top.platform]}, 👁 ${top.views})`,
    )
  return out
}

export const videoReport = async (now = new Date()) =>
  buildVideoReport(await loadVideoReportRows(now))
