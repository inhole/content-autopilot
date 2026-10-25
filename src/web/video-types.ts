// Shapes of the video pages (docs/plans/video-upload.md 6-7), kept free of runtime imports: the
// React app type-checks api-types.ts and everything it imports.
import type {
  Platform,
  PublicationStatus,
  Scene,
  VideoOrigin,
  VideoStatus,
} from '../video/types.ts'

export type VideoListFilter = 'active' | 'all'

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
