import { type Query, query, transaction } from '../db/pool.ts'
import type { Script, ScriptSource, StoredVideoGeneration } from './script.ts'
import {
  captionProblems,
  charCount,
  cleanHashtags,
  composeCaption,
  LIMITS,
  type Scene,
  sceneEditProblem,
  sourceLabel,
  type VideoOrigin,
  type VideoStatus,
  YOUTUBE_TITLE_LIMIT,
} from './types.ts'

// The videos row is the source of truth (docs/plans/video.md 3-5..3-7). Every transition is a
// conditional UPDATE that reports whether it applied, so stale jobs, buttons and replies change
// nothing.

export type VideoRow = {
  id: number
  /** Null for an owner upload. */
  post_id: number | null
  origin: VideoOrigin
  status: VideoStatus
  title: string | null
  caption: string | null
  hashtags: string[]
  scenes: Scene[] | null
  source_url: string | null
  source_label: string | null
  generation: StoredVideoGeneration | null
  revision: number
  regen_seq: number
  regen_feedback: string | null
  stage_recoveries: number
  render_hash: string | null
  video_url: string | null
  storage_key: string | null
  duration_ms: number | null
  size_bytes: number | null
  review_chat_id: number | null
  review_message_id: number | null
  script_message_id: number | null
  review_revision: number | null
  last_error: string | null
  published_at: Date | null
  upload_started_at: Date | null
  original_name: string | null
  width: number | null
  height: number | null
  created_at: Date
  updated_at: Date
}

export async function loadVideo(id: number, q: Query = query): Promise<VideoRow | null> {
  const [row] = await q<VideoRow>('select * from videos where id = $1', [id])
  return row ?? null
}

export async function videoIdForPost(postId: number): Promise<number | null> {
  const [row] = await query<{ id: number }>('select id from videos where post_id = $1', [postId])
  return row?.id ?? null
}

/** The script fields of a row, once a script exists. */
export function scriptOf(v: VideoRow): Script | null {
  if (!v.scenes || v.title == null || v.caption == null) return null
  return { title: v.title, caption: v.caption, hashtags: v.hashtags, scenes: v.scenes }
}

/** The caption as published: script caption + source link + hashtags. */
export const fullCaption = (v: VideoRow) =>
  composeCaption({ caption: v.caption ?? '', sourceUrl: v.source_url, hashtags: v.hashtags })

export type CreateResult = { created: number } | { exists: number } | { notEligible: string }

/**
 * Creates the video row for a published single-source post (docs/plans/video.md 3-4). An
 * existing row is reported, not replaced.
 */
export async function createVideo(postId: number): Promise<CreateResult> {
  const [post] = await query<{ status: string; origin: string; source_url: string | null }>(
    'select status, origin, source_url from posts where id = $1',
    [postId],
  )
  if (!post) return { notEligible: '글을 찾을 수 없어요' }
  if (post.status !== 'PUBLISHED') return { notEligible: '발행된 글만 영상으로 만들 수 있어요' }
  if (post.origin === 'digest')
    return { notEligible: '묶음 글은 출처가 여러 개라 영상으로 만들지 않아요' }
  const [row] = await query<{ id: number }>(
    `insert into videos (post_id, source_url, source_label) values ($1, $2, $3)
     on conflict (post_id) do nothing returning id`,
    [postId, post.source_url, sourceLabel(post.source_url)],
  )
  if (row) return { created: row.id }
  const existing = await videoIdForPost(postId)
  if (existing === null) throw new Error(`video for post ${postId} vanished`)
  return { exists: existing }
}

/** What the script writer reads: the published post, its follow-ups and the topic. */
export async function loadScriptSource(
  videoId: number,
): Promise<(ScriptSource & { seq: number }) | null> {
  const [row] = await query<{
    text: string
    title: string
    source_label: string | null
    regen_seq: number
    regen_feedback: string | null
    followups: string[]
  }>(
    `select p.text, t.title, v.source_label, v.regen_seq, v.regen_feedback,
            array(select pp.text from post_parts pp where pp.post_id = p.id order by pp.idx)
              as followups
     from videos v join posts p on p.id = v.post_id join topics t on t.id = p.topic_id
     where v.id = $1`,
    [videoId],
  )
  if (!row) return null
  const video = await loadVideo(videoId)
  return {
    postText: row.text,
    followups: row.followups,
    topicTitle: row.title,
    sourceLabel: row.source_label,
    feedback: row.regen_feedback,
    previous: video ? scriptOf(video) : null,
    seq: row.regen_seq,
  }
}

/** The same source for a post without a video row (read-only CLI preview). */
export async function loadPostScriptSource(postId: number): Promise<ScriptSource | null> {
  const [row] = await query<{
    text: string
    title: string
    source_url: string | null
    followups: string[]
  }>(
    `select p.text, t.title, p.source_url,
            array(select pp.text from post_parts pp where pp.post_id = p.id order by pp.idx)
              as followups
     from posts p join topics t on t.id = p.topic_id where p.id = $1`,
    [postId],
  )
  if (!row) return null
  return {
    postText: row.text,
    followups: row.followups,
    topicTitle: row.title,
    sourceLabel: sourceLabel(row.source_url),
  }
}

/**
 * Stores a written script, only for the latest request (`regen_seq = seq`) while still SCRIPTING:
 * an older or duplicate job writes nothing. Moves on to RENDERING.
 */
export async function applyScript(
  videoId: number,
  seq: number,
  script: Script,
  generation: StoredVideoGeneration,
): Promise<boolean> {
  const rows = await query(
    `update videos set title = $3, caption = $4, hashtags = $5, scenes = $6, generation = $7,
       revision = revision + 1, status = 'RENDERING', stage_recoveries = 0, last_error = null,
       updated_at = now()
     where id = $1 and status = 'SCRIPTING' and regen_seq = $2
     returning id`,
    [
      videoId,
      seq,
      script.title,
      script.caption,
      script.hashtags,
      JSON.stringify(script.scenes),
      JSON.stringify(generation),
    ],
  )
  return rows.length > 0
}

/**
 * What a review action is bound to: a button on the registered video message (with the revision
 * it showed), a reply to either registered message, or (CLI) a plain revision.
 */
export type ReviewGuard =
  | { messageId: number; revision: number }
  | { replyTo: number }
  | { revision: number }

/** SQL condition for `guard`, with parameters starting at `$<from>`. */
export function guardSql(guard: ReviewGuard, from: number): { sql: string; params: unknown[] } {
  if ('messageId' in guard) {
    return {
      sql: `review_message_id = $${from} and revision = $${from + 1} and review_revision = revision`,
      params: [guard.messageId, guard.revision],
    }
  }
  if ('replyTo' in guard) {
    return {
      sql: `$${from} in (review_message_id, script_message_id) and review_revision = revision`,
      params: [guard.replyTo],
    }
  }
  return { sql: `revision = $${from}`, params: [guard.revision] }
}

/**
 * Asks for a new script (🔁 or reply feedback). The seq and the feedback are stored together, so a
 * crash before the enqueue is recovered by maintenance with the same feedback. Returns the new seq.
 */
export async function requestRescript(
  videoId: number,
  guard: ReviewGuard,
  feedback: string | null,
): Promise<number | null> {
  const g = guardSql(guard, 3)
  const [row] = await query<{ regen_seq: number }>(
    `update videos set status = 'SCRIPTING', regen_seq = regen_seq + 1, regen_feedback = $2,
       revision = revision + 1, stage_recoveries = 0, last_error = null, updated_at = now()
     where id = $1 and status = 'PENDING_REVIEW' and origin = 'generated' and ${g.sql}
     returning regen_seq`,
    [videoId, feedback, ...g.params],
  )
  return row?.regen_seq ?? null
}

/**
 * Starts a FAILED or EXPIRED generated video over from the script (`/video <postId>` on an old
 * row). A video that failed because every publication was cancelled loses those rows, so the next
 * approval can create them again.
 */
export async function restartVideo(videoId: number): Promise<number | null> {
  return transaction(async (q) => {
    const [row] = await q<{ regen_seq: number }>(
      `update videos set status = 'SCRIPTING', regen_seq = regen_seq + 1, regen_feedback = null,
         revision = revision + 1, stage_recoveries = 0, last_error = null, updated_at = now()
       where id = $1 and status in ('FAILED', 'EXPIRED') and origin = 'generated'
         and not exists (
           select 1 from video_publications p where p.video_id = videos.id
             and p.status <> 'CANCELLED'
         )
       returning regen_seq`,
      [videoId],
    )
    if (!row) return null
    await q('delete from video_publications where video_id = $1', [videoId])
    return row.regen_seq
  })
}

export type RenderJob = {
  revision: number
  scenes: Scene[]
  source_label: string | null
  render_hash: string | null
}

/** The render input, read once at the start of a render. Null unless RENDERING. */
export async function loadRenderJob(videoId: number): Promise<RenderJob | null> {
  const [row] = await query<RenderJob>(
    `select revision, scenes, source_label, render_hash from videos
     where id = $1 and status = 'RENDERING' and scenes is not null`,
    [videoId],
  )
  return row ?? null
}

/**
 * Stores a finished render, only if the script is still the revision it was rendered from.
 * Returns the replaced storage key (to delete), or `applied: false` when the render is stale.
 */
export async function applyRender(
  videoId: number,
  revision: number,
  r: { hash: string; url: string; key: string; durationMs: number; sizeBytes: number },
): Promise<{ applied: boolean; previousKey: string | null }> {
  const [row] = await query<{ previous_key: string | null }>(
    `with old as (select storage_key from videos where id = $1 for update)
     update videos v set render_hash = $3, video_url = $4, storage_key = $5, duration_ms = $6,
       size_bytes = $7, rendered_at = now(), storage_deleted_at = null,
       status = 'PENDING_REVIEW', stage_recoveries = 0,
       last_error = null, review_message_id = null, script_message_id = null,
       review_revision = null, updated_at = now()
     from old
     where v.id = $1 and v.status = 'RENDERING' and v.revision = $2
     returning old.storage_key as previous_key`,
    [videoId, revision, r.hash, r.url, r.key, r.durationMs, r.sizeBytes],
  )
  if (!row) return { applied: false, previousKey: null }
  return { applied: true, previousKey: row.previous_key === r.key ? null : row.previous_key }
}

/** The script changed in a way that does not change the video (same render hash): back to review. */
export async function skipRender(
  videoId: number,
  revision: number,
  hash: string,
): Promise<boolean> {
  const rows = await query(
    `update videos set status = 'PENDING_REVIEW', stage_recoveries = 0, last_error = null,
       review_message_id = null, script_message_id = null, review_revision = null,
       updated_at = now()
     where id = $1 and status = 'RENDERING' and revision = $2 and render_hash = $3
       and video_url is not null
     returning id`,
    [videoId, revision, hash],
  )
  return rows.length > 0
}

/**
 * Ends a script or render stage that cannot succeed. `owner` is the stage's ownership token (the
 * script's regen_seq, the render's revision): a video that left the stage, or a newer request of
 * the same stage, is untouched.
 */
export async function failStage(
  videoId: number,
  stage: 'SCRIPTING' | 'RENDERING',
  owner: number,
  error: string,
): Promise<boolean> {
  const rows = await query(
    `update videos set status = 'FAILED', last_error = $3, updated_at = now()
     where id = $1 and status = $2
       and (case when $2 = 'SCRIPTING' then regen_seq else revision end) = $4
     returning id`,
    [videoId, stage, error.slice(0, 1000), owner],
  )
  return rows.length > 0
}

/**
 * Registers the two review messages of one revision in a single UPDATE. Returns the previous
 * message ids (to strip their buttons), or null when the video moved on while sending.
 */
export async function registerReview(
  videoId: number,
  revision: number,
  chatId: number,
  scriptMessageId: number,
  videoMessageId: number,
): Promise<{ previous: number[] } | null> {
  const [row] = await query<{ prev_review: number | null; prev_script: number | null }>(
    `with old as (
       select review_message_id, script_message_id from videos where id = $1 for update
     )
     update videos v set review_chat_id = $3, script_message_id = $4, review_message_id = $5,
       review_revision = $2, updated_at = now()
     from old
     where v.id = $1 and v.status = 'PENDING_REVIEW' and v.revision = $2
     returning old.review_message_id as prev_review, old.script_message_id as prev_script`,
    [videoId, revision, chatId, scriptMessageId, videoMessageId],
  )
  if (!row) return null
  return {
    previous: [row.prev_review, row.prev_script].filter(
      (id): id is number => id != null && id !== videoMessageId && id !== scriptMessageId,
    ),
  }
}

export type EditOp =
  | { kind: 'narration' | 'heading'; idx: number; text: string }
  | { kind: 'title' | 'caption'; text: string }

export type EditResult = { ok: true; rerender: boolean } | { ok: false; message: string }

const STALE = '이미 처리됐거나 최신 원고가 아니라서 고치지 못했어요.'

/**
 * Applies an owner edit bound to `guard`. Scene edits replace the scene, bump the revision and go
 * back to RENDERING in one UPDATE, so a render started before the edit cannot land. Title and
 * caption edits keep the video (same render) and only bump the revision.
 */
export async function applyEdit(
  videoId: number,
  guard: ReviewGuard,
  op: EditOp,
): Promise<EditResult> {
  return transaction(async (q) => {
    const g = guardSql(guard, 2)
    const [v] = await q<VideoRow>(
      `select * from videos where id = $1 and status = 'PENDING_REVIEW' and ${g.sql} for update`,
      [videoId, ...g.params],
    )
    if (!v) return { ok: false, message: STALE }
    if (op.kind === 'title') {
      const text = op.text.trim()
      if (!text) return { ok: false, message: '바꿀 내용이 비어 있어요.' }
      if (charCount(text) > YOUTUBE_TITLE_LIMIT) {
        return { ok: false, message: `제목은 ${YOUTUBE_TITLE_LIMIT}자를 넘을 수 없어요.` }
      }
      await q(
        'update videos set title = $2, revision = revision + 1, updated_at = now() where id = $1',
        [videoId, text],
      )
      return { ok: true, rerender: false }
    }
    if (op.kind === 'caption') {
      const text = op.text.trim()
      if (!text) return { ok: false, message: '바꿀 내용이 비어 있어요.' }
      const problems = captionProblems(
        composeCaption({ caption: text, sourceUrl: v.source_url, hashtags: v.hashtags }),
      )
      if (problems.length) return { ok: false, message: problems.join(', ') }
      await q(
        'update videos set caption = $2, revision = revision + 1, updated_at = now() where id = $1',
        [videoId, text],
      )
      return { ok: true, rerender: false }
    }
    if (!v.scenes) return { ok: false, message: '직접 올린 영상은 장면을 고칠 수 없어요.' }
    const { kind, idx } = op as Extract<EditOp, { idx: number }>
    const text = op.text.trim()
    const problem = sceneEditProblem(kind, text, v.scenes, idx)
    if (problem) return { ok: false, message: problem }
    const scenes = v.scenes.map((s, i) => (i === idx - 1 ? { ...s, [kind]: text } : s))
    await q(
      `update videos set scenes = $2, revision = revision + 1, status = 'RENDERING',
         stage_recoveries = 0, updated_at = now()
       where id = $1`,
      [videoId, JSON.stringify(scenes)],
    )
    return { ok: true, rerender: true }
  })
}

export type MetaEdit = { title: string; caption: string; hashtags: string[] }

/** Why title, caption and hashtags cannot be used together, or null. */
export function metaProblem(edit: MetaEdit, sourceUrl: string | null): string | null {
  const title = edit.title.trim()
  if (!title) return '제목을 넣어 주세요.'
  if (charCount(title) > YOUTUBE_TITLE_LIMIT) {
    return `제목은 ${YOUTUBE_TITLE_LIMIT}자를 넘을 수 없어요.`
  }
  // cleanHashtags cuts to the limit (fine for the LLM); an owner's extra tags are refused instead.
  const distinct = new Set(
    edit.hashtags.map((t) => t.replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean),
  )
  if (distinct.size > LIMITS.hashtags) return `해시태그는 ${LIMITS.hashtags}개까지예요.`
  const hashtags = cleanHashtags(edit.hashtags)
  const problems = captionProblems(
    composeCaption({ caption: edit.caption.trim(), sourceUrl, hashtags }),
  )
  return problems.length ? problems.join(', ') : null
}

/**
 * Replaces title, caption and hashtags together (the admin console): the final values are checked
 * as one, and the revision moves once. Under review only; the video file stays.
 */
export async function applyMetaEdit(
  videoId: number,
  guard: ReviewGuard,
  edit: MetaEdit,
): Promise<{ ok: true } | { ok: false; message: string; stale?: true }> {
  return transaction(async (q) => {
    const g = guardSql(guard, 2)
    const [v] = await q<VideoRow>(
      `select * from videos where id = $1 and status = 'PENDING_REVIEW' and ${g.sql} for update`,
      [videoId, ...g.params],
    )
    if (!v) return { ok: false, message: STALE, stale: true }
    const problem = metaProblem(edit, v.source_url)
    if (problem) return { ok: false, message: problem }
    await q(
      `update videos set title = $2, caption = $3, hashtags = $4, revision = revision + 1,
         updated_at = now()
       where id = $1`,
      [videoId, edit.title.trim(), edit.caption.trim(), cleanHashtags(edit.hashtags)],
    )
    return { ok: true }
  })
}

export async function rejectVideo(videoId: number, guard: ReviewGuard): Promise<boolean> {
  const g = guardSql(guard, 2)
  const rows = await query(
    `update videos set status = 'REJECTED', updated_at = now()
     where id = $1 and status = 'PENDING_REVIEW' and ${g.sql} returning id`,
    [videoId, ...g.params],
  )
  return rows.length > 0
}

/**
 * `📤 직접 올림`: an approved video without automatic publications was uploaded by hand. Bound to
 * the approved revision, so a button or page from before an unapprove/re-approve does nothing.
 */
export async function markManualPublished(videoId: number, revision: number): Promise<boolean> {
  const rows = await query(
    `update videos set status = 'PUBLISHED', published_at = now(), updated_at = now()
     where id = $1 and status = 'APPROVED' and revision = $2
       and not exists (select 1 from video_publications p where p.video_id = videos.id)
     returning id`,
    [videoId, revision],
  )
  return rows.length > 0
}

// An APPROVED video is finished once every publication is PUBLISHED or CANCELLED: PUBLISHED when
// at least one went out, FAILED when the owner cancelled them all (docs/plans/video-upload.md 4).
const FINISH_SET = `status = case when exists (
         select 1 from video_publications p where p.video_id = v.id and p.status = 'PUBLISHED'
       ) then 'PUBLISHED' else 'FAILED' end,
       published_at = (select max(p.published_at) from video_publications p
                       where p.video_id = v.id and p.status = 'PUBLISHED'),
       updated_at = now()`
const FINISHABLE = `v.status = 'APPROVED'
       and exists (select 1 from video_publications p where p.video_id = v.id)
       and not exists (
         select 1 from video_publications p where p.video_id = v.id
           and p.status not in ('PUBLISHED', 'CANCELLED')
       )`

/** Finishes an approved video once every publication is done; returns the new status. */
export async function completeIfAllPublished(
  videoId: number,
  q: Query = query,
): Promise<'PUBLISHED' | 'FAILED' | null> {
  const [row] = await q<{ status: 'PUBLISHED' | 'FAILED' }>(
    `update videos v set ${FINISH_SET} where v.id = $1 and ${FINISHABLE} returning v.status`,
    [videoId],
  )
  return row?.status ?? null
}

/**
 * Finishes APPROVED videos whose publications are all done but whose own completion was lost
 * (the worker stopped between the two updates). Run with every publish-due sweep.
 */
export async function completePublishedVideos(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `update videos v set ${FINISH_SET} where ${FINISHABLE} returning v.id`,
  )
  return rows.map((r) => r.id)
}

/**
 * Takes an approval back (the admin console): only while every publication is SCHEDULED and was
 * never claimed. A row back in SCHEDULED after an attempt may already exist on the platform (a
 * Reels container, a Shorts session), so it is not cancelled this way. The claim of a publish job
 * waits on the row lock and then finds nothing.
 */
export async function unapproveVideo(
  videoId: number,
  revision: number,
): Promise<{ ok: true } | { ok: false; message: string; stale?: true }> {
  return transaction(async (q) => {
    const [v] = await q<{ id: number }>(
      "select id from videos where id = $1 and status = 'APPROVED' and revision = $2 for update",
      [videoId, revision],
    )
    if (!v) return { ok: false, message: STALE, stale: true }
    const pubs = await q<{ status: string; claim_seq: number }>(
      'select status, claim_seq from video_publications where video_id = $1 for update',
      [videoId],
    )
    if (pubs.some((p) => p.status !== 'SCHEDULED' || Number(p.claim_seq) > 0)) {
      return { ok: false, message: '이미 발행을 시작해서 승인을 취소할 수 없어요.' }
    }
    await q('delete from video_publications where video_id = $1', [videoId])
    await q(
      `update videos set status = 'PENDING_REVIEW', revision = revision + 1,
         review_message_id = null, script_message_id = null, review_revision = null,
         updated_at = now()
       where id = $1`,
      [videoId],
    )
    return { ok: true }
  })
}

// Maintenance

export const REVIEW_EXPIRE_HOURS = 72
export const UNSENT_REVIEW_MINUTES = 10
export const STUCK_STAGE_MINUTES = 45
export const MAX_STAGE_RECOVERIES = 2

export const UPLOAD_EXPIRE_HOURS = 1

/**
 * Expires upload rows whose file never arrived. Counted from the latest file request, so a
 * request in progress (minutes long at most) is never expired under it.
 */
export async function expireUploads(now = new Date()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `update videos set status = 'EXPIRED', updated_at = now()
     where status = 'UPLOADING'
       and greatest(created_at, coalesce(upload_started_at, created_at))
         < $1::timestamptz - make_interval(hours => $2)
     returning id`,
    [now, UPLOAD_EXPIRE_HOURS],
  )
  return rows.map((r) => r.id)
}

/** Expires reviews left untouched; returns their message ids so the buttons can be removed. */
export async function expireVideos(
  now = new Date(),
): Promise<{ id: number; chatId: number | null; messageId: number | null }[]> {
  const rows = await query<{
    id: number
    review_chat_id: number | null
    review_message_id: number | null
  }>(
    `update videos set status = 'EXPIRED', updated_at = now()
     where status = 'PENDING_REVIEW' and updated_at < $1::timestamptz - make_interval(hours => $2)
     returning id, review_chat_id, review_message_id`,
    [now, REVIEW_EXPIRE_HOURS],
  )
  return rows.map((r) => ({ id: r.id, chatId: r.review_chat_id, messageId: r.review_message_id }))
}

/**
 * PENDING_REVIEW videos without a current review message: never registered (a crash or lost
 * enqueue), or registered for an older revision whose re-send failed (a title/caption edit).
 */
export async function unsentReviews(now = new Date()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from videos
     where status = 'PENDING_REVIEW'
       and (review_message_id is null or review_revision is distinct from revision)
       and updated_at < $1::timestamptz - make_interval(mins => $2)
     order by id`,
    [now, UNSENT_REVIEW_MINUTES],
  )
  return rows.map((r) => r.id)
}

export const isUnsentReview = async (videoId: number) =>
  (
    await query(
      `select 1 from videos where id = $1 and status = 'PENDING_REVIEW'
         and (review_message_id is null or review_revision is distinct from revision)`,
      [videoId],
    )
  ).length > 0

export type StuckStage = { id: number; status: 'SCRIPTING' | 'RENDERING'; seq: number }

/**
 * Claims stuck SCRIPTING/RENDERING rows for one more try: bumps stage_recoveries and updated_at
 * (so the next sweep waits again). Rows that already used their recoveries are failed instead.
 */
export async function recoverStuckStages(
  now = new Date(),
): Promise<{ retry: StuckStage[]; failed: number[] }> {
  const failed = await query<{ id: number }>(
    `update videos set status = 'FAILED', last_error = coalesce(last_error, 'stuck'),
       updated_at = now()
     where status in ('SCRIPTING', 'RENDERING') and stage_recoveries >= $3
       and updated_at < $1::timestamptz - make_interval(mins => $2)
     returning id`,
    [now, STUCK_STAGE_MINUTES, MAX_STAGE_RECOVERIES],
  )
  const retry = await query<{ id: number; status: 'SCRIPTING' | 'RENDERING'; regen_seq: number }>(
    `update videos set stage_recoveries = stage_recoveries + 1, updated_at = now()
     where status in ('SCRIPTING', 'RENDERING') and stage_recoveries < $3
       and updated_at < $1::timestamptz - make_interval(mins => $2)
     returning id, status, regen_seq`,
    [now, STUCK_STAGE_MINUTES, MAX_STAGE_RECOVERIES],
  )
  return {
    retry: retry.map((r) => ({ id: r.id, status: r.status, seq: r.regen_seq })),
    failed: failed.map((r) => r.id),
  }
}

/** Active videos for `/videos` and `video:list`. */
export async function listVideos(limit = 15): Promise<
  {
    id: number
    post_id: number | null
    origin: VideoOrigin
    status: VideoStatus
    title: string | null
    duration_ms: number | null
    scheduled_at: Date | null
  }[]
> {
  return query(
    `select v.id, v.post_id, v.origin, v.status, v.title, v.duration_ms,
            (select min(p.scheduled_at) from video_publications p where p.video_id = v.id
               and p.status in ('SCHEDULED', 'PUBLISHING')) as scheduled_at
     from videos v order by v.id desc limit $1`,
    [limit],
  )
}
