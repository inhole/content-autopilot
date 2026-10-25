import { query } from '../db/pool.ts'
import { fullCaption, loadVideo } from '../video/store.ts'
import {
  LIMITS,
  type Platform,
  type PublicationStatus,
  type Scene,
  type VideoOrigin,
  type VideoStatus,
  YOUTUBE_TITLE_LIMIT,
} from '../video/types.ts'
import { uploadMaxBytes } from '../video/upload.ts'

// Read side of the video pages (docs/plans/video-upload.md 6-7). Shapes are the contract in
// api-types.ts; dates become ISO strings there.

export type VideoListFilter = 'active' | 'all'

const ACTIVE = `v.status in ('UPLOADING', 'SCRIPTING', 'RENDERING', 'PENDING_REVIEW', 'APPROVED')
  or v.updated_at > now() - interval '7 days'`

export const parseVideoFilter = (raw: string | null): VideoListFilter =>
  raw === 'all' ? 'all' : 'active'

export type VideoPublicationSummary = {
  id: number
  platform: Platform
  status: PublicationStatus
  scheduled_at: Date
  published_at: Date | null
}

export type VideoListRow = {
  id: number
  origin: VideoOrigin
  post_id: number | null
  status: VideoStatus
  title: string | null
  duration_ms: number | null
  width: number | null
  height: number | null
  created_at: Date
  updated_at: Date
  publications: VideoPublicationSummary[]
}

export async function loadVideoList(filter: VideoListFilter, limit = 100): Promise<VideoListRow[]> {
  const rows = await query<Omit<VideoListRow, 'publications'> & { publications: unknown }>(
    `select v.id, v.origin, v.post_id, v.status, v.title, v.duration_ms, v.width, v.height,
            v.created_at, v.updated_at,
            coalesce((
              select json_agg(json_build_object(
                'id', p.id, 'platform', p.platform, 'status', p.status,
                'scheduled_at', p.scheduled_at, 'published_at', p.published_at
              ) order by p.platform)
              from video_publications p where p.video_id = v.id
            ), '[]'::json) as publications
     from videos v
     ${filter === 'active' ? `where ${ACTIVE}` : ''}
     order by v.id desc limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    ...r,
    publications: (
      r.publications as (Omit<VideoPublicationSummary, 'scheduled_at' | 'published_at'> & {
        scheduled_at: string
        published_at: string | null
      })[]
    ).map((p) => ({
      ...p,
      scheduled_at: new Date(p.scheduled_at),
      published_at: p.published_at ? new Date(p.published_at) : null,
    })),
  }))
}

export type VideoPublicationDetail = VideoPublicationSummary & {
  attempts: number
  /** The latest attempt: the guard of retry and cancel. */
  claim_seq: number
  permalink: string | null
  platform_media_id: string | null
  last_error: string | null
  error_kind: string | null
}

export type VideoDetailData = {
  video: {
    id: number
    origin: VideoOrigin
    post_id: number | null
    status: VideoStatus
    revision: number
    title: string | null
    caption: string | null
    hashtags: string[]
    source_url: string | null
    scenes: Scene[] | null
    /** The caption as published: caption + source line + hashtags. */
    full_caption: string
    video_url: string | null
    duration_ms: number | null
    size_bytes: number | null
    width: number | null
    height: number | null
    original_name: string | null
    last_error: string | null
    created_at: Date
    updated_at: Date
    published_at: Date | null
  }
  post: { id: number; text: string } | null
  publications: VideoPublicationDetail[]
  limits: {
    title: number
    caption: number
    hashtags: number
    uploadMaxBytes: number
    uploadTypes: string[]
  }
}

/** Accepted request types of the file route. */
export const UPLOAD_TYPES = ['video/mp4', 'video/quicktime']

export const videoLimits = (): VideoDetailData['limits'] => ({
  title: YOUTUBE_TITLE_LIMIT,
  caption: 2200,
  hashtags: LIMITS.hashtags,
  uploadMaxBytes: uploadMaxBytes(),
  uploadTypes: UPLOAD_TYPES,
})

export async function loadVideoDetail(id: number): Promise<VideoDetailData | null> {
  const v = await loadVideo(id)
  if (!v) return null
  const publications = await query<VideoPublicationDetail>(
    `select id, platform, status, scheduled_at, published_at, attempts, claim_seq, permalink,
            platform_media_id, last_error, error_kind
     from video_publications where video_id = $1 order by platform`,
    [id],
  )
  const [post] = v.post_id
    ? await query<{ id: number; text: string }>('select id, text from posts where id = $1', [
        v.post_id,
      ])
    : []
  return {
    video: {
      id: v.id,
      origin: v.origin,
      post_id: v.post_id,
      status: v.status,
      revision: v.revision,
      title: v.title,
      caption: v.caption,
      hashtags: v.hashtags,
      source_url: v.source_url,
      scenes: v.scenes,
      full_caption: fullCaption(v),
      video_url: v.video_url,
      duration_ms: v.duration_ms,
      size_bytes: v.size_bytes,
      width: v.width,
      height: v.height,
      original_name: v.original_name,
      last_error: v.last_error,
      created_at: v.created_at,
      updated_at: v.updated_at,
      published_at: v.published_at,
    },
    post: post ?? null,
    publications,
    limits: videoLimits(),
  }
}
