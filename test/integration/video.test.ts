import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import {
  approveVideo,
  reschedulePublication,
  resetDryRun,
  VideoNotReviewableError,
} from '../../src/video/approve.ts'
import { cleanupVideoFiles } from '../../src/video/cleanup.ts'
import { collectVideoInsights, loadVideoReportRows } from '../../src/video/insights.ts'
import { InstagramApiError } from '../../src/video/instagram.ts'
import { bestCandidate, pickVideo } from '../../src/video/pick.ts'
import { runRender, runScript } from '../../src/video/pipeline.ts'
import { duePublications, publishPublication, unalertedFailures } from '../../src/video/publish.ts'
import type { RenderResult, renderVideo } from '../../src/video/render.ts'
import type { Script } from '../../src/video/script.ts'
import {
  applyEdit,
  createVideo,
  expireVideos,
  loadVideo,
  recoverStuckStages,
  registerReview,
  rejectVideo,
  requestRescript,
  unsentReviews,
} from '../../src/video/store.ts'
import { retryPublication } from '../../src/video/telegram.ts'
import { SilentTts } from '../../src/video/tts.ts'
import type { Platform } from '../../src/video/types.ts'
import { FakeInstagram, FakeStorage, FakeYouTube } from '../fake-video.ts'
import { seedTopic } from './helpers.ts'

const SCRIPT: Script = {
  title: '영상 제목',
  caption: '캡션이야.',
  hashtags: ['AI'],
  scenes: [
    { heading: '훅', narration: '첫 문장이야.' },
    { heading: '본문', narration: '둘째 문장이야.' },
    { heading: '해석', narration: '셋째 문장이야.' },
  ],
}

async function seedPublishedPost(
  opts: { views?: number; origin?: string; mediaId?: string; daysAgo?: number } = {},
): Promise<number> {
  const topicId = await seedTopic({ status: 'USED', url: null })
  const [row] = await query<{ id: number }>(
    `insert into posts (topic_id, text, status, origin, source_url, platform_post_id, published_at)
     values ($1, '발행된 글', 'PUBLISHED', $2, 'https://example.com/a', $3,
             now() - make_interval(days => $4))
     returning id`,
    [topicId, opts.origin ?? 'news', opts.mediaId ?? `m${topicId}`, opts.daysAgo ?? 1],
  )
  if (!row) throw new Error('seed failed')
  if (opts.views !== undefined) {
    await query('insert into post_insights (post_id, views) values ($1, $2)', [row.id, opts.views])
  }
  return row.id
}

const writer = (seen?: { feedback?: string | null }[]) =>
  (async (src: { feedback?: string | null }) => {
    seen?.push({ feedback: src.feedback })
    return {
      script: SCRIPT,
      generation: { model: 'm', prompt_version: 1, feedback: src.feedback ?? null },
    }
  }) as never

let sha = 0
function fakeRender(onRender?: () => Promise<void>): typeof renderVideo {
  return (async () => {
    await onRender?.()
    const result: RenderResult = {
      path: 'unused',
      dir: 'unused',
      durationMs: 30_000,
      sizeBytes: 1000,
      sha256: String(++sha).padStart(64, '0'),
      timeline: { cues: [], audio: [], totalMs: 30_000 },
      cleanup: async () => {},
    }
    return result
  }) as typeof renderVideo
}

const tts = new SilentTts()

/** A video in PENDING_REVIEW with registered review messages (script 100+, video 101+). */
async function videoUnderReview(storage = new FakeStorage()) {
  const postId = await seedPublishedPost()
  const created = await createVideo(postId)
  if (!('created' in created)) throw new Error('not created')
  const id = created.created
  expect(await runScript(id, 1, { write: writer() })).toBe(true)
  expect((await runRender(id, { tts, storage, render: fakeRender(), bgm: null })).kind).toBe(
    'rendered',
  )
  const v = await loadVideo(id)
  if (!v) throw new Error('missing')
  const msg = 100 + id * 2
  expect(await registerReview(id, v.revision, 1, msg, msg + 1)).not.toBeNull()
  return { id, postId, storage, videoMsg: msg + 1, scriptMsg: msg, revision: v.revision }
}

async function approved(platforms: Platform[]) {
  const r = await videoUnderReview()
  const approval = await approveVideo(
    r.id,
    { messageId: r.videoMsg, revision: r.revision },
    { platforms },
  )
  const pubs = await query<{ id: number; platform: Platform }>(
    'select id, platform from video_publications where video_id = $1 order by id',
    [r.id],
  )
  return { ...r, approval, pubs }
}

const pub = async (id: number) => {
  const [row] = await query<{
    status: string
    attempts: number
    container_id: string | null
    upload_url: string | null
    platform_media_id: string | null
    permalink: string | null
    error_kind: string | null
    scheduled_at: Date
  }>('select * from video_publications where id = $1', [id])
  if (!row) throw new Error('missing publication')
  return row
}

const noSleep = { sleep: async () => {} }

describe('video creation and script', () => {
  it('only takes published single-source posts, once', async () => {
    const draft = await query<{ id: number }>(
      "insert into posts (topic_id, text) values ($1, 't') returning id",
      [await seedTopic()],
    )
    expect(await createVideo(draft[0]?.id ?? 0)).toEqual({
      notEligible: '발행된 글만 영상으로 만들 수 있어요',
    })
    const digest = await seedPublishedPost({ origin: 'digest' })
    expect(await createVideo(digest)).toHaveProperty('notEligible')
    const postId = await seedPublishedPost()
    const created = await createVideo(postId)
    expect(created).toHaveProperty('created')
    expect(await createVideo(postId)).toEqual({ exists: (created as { created: number }).created })
    const v = await loadVideo((created as { created: number }).created)
    expect(v).toMatchObject({ status: 'SCRIPTING', source_label: 'example.com', regen_seq: 1 })
  })

  it('applies a script only for the latest request', async () => {
    const r = await videoUnderReview()
    const seen: { feedback?: string | null }[] = []
    const seq = await requestRescript(r.id, { replyTo: r.scriptMsg }, '더 짧게')
    expect(seq).toBe(2)
    expect(await runScript(r.id, 1, { write: writer(seen) })).toBe(false)
    expect(seen).toEqual([])
    expect(await runScript(r.id, 2, { write: writer(seen) })).toBe(true)
    expect(seen).toEqual([{ feedback: '더 짧게' }])
    expect(await runScript(r.id, 2, { write: writer(seen) })).toBe(false)
    expect((await loadVideo(r.id))?.status).toBe('RENDERING')
  })
})

describe('render ownership', () => {
  it('drops a render whose script changed meanwhile and deletes only its own upload', async () => {
    const storage = new FakeStorage()
    const postId = await seedPublishedPost()
    const id = ((await createVideo(postId)) as { created: number }).created
    await runScript(id, 1, { write: writer() })
    const outcome = await runRender(id, {
      tts,
      storage,
      bgm: null,
      render: fakeRender(async () => {
        await query('update videos set revision = revision + 1 where id = $1', [id])
      }),
    })
    expect(outcome.kind).toBe('stale')
    expect(storage.removed).toHaveLength(1)
    expect(storage.files.size).toBe(0)
    expect((await loadVideo(id))?.video_url).toBeNull()
  })

  it('re-renders after a scene edit and deletes the replaced file', async () => {
    const r = await videoUnderReview()
    const before = await loadVideo(r.id)
    const edit = await applyEdit(
      r.id,
      { replyTo: r.videoMsg },
      { kind: 'heading', idx: 2, text: '새 문구' },
    )
    expect(edit).toEqual({ ok: true, rerender: true })
    const mid = await loadVideo(r.id)
    expect(mid).toMatchObject({ status: 'RENDERING', revision: (before?.revision ?? 0) + 1 })
    expect(mid?.scenes?.[1]?.heading).toBe('새 문구')
    expect(
      (await runRender(r.id, { tts, storage: r.storage, render: fakeRender(), bgm: null })).kind,
    ).toBe('rendered')
    expect(r.storage.removed).toEqual([before?.storage_key])
  })

  it('skips rendering when nothing that changes the video changed', async () => {
    const r = await videoUnderReview()
    await query("update videos set status = 'RENDERING' where id = $1", [r.id])
    const render = fakeRender(async () => {
      throw new Error('should not render')
    })
    expect((await runRender(r.id, { tts, storage: r.storage, render, bgm: null })).kind).toBe(
      'unchanged',
    )
    expect((await loadVideo(r.id))?.status).toBe('PENDING_REVIEW')
  })
})

describe('review guards', () => {
  it('registers review messages only for the current revision', async () => {
    const r = await videoUnderReview()
    expect(await registerReview(r.id, r.revision - 1, 1, 900, 901)).toBeNull()
    const again = await registerReview(r.id, r.revision, 1, 902, 903)
    expect(again?.previous.sort()).toEqual([r.scriptMsg, r.videoMsg].sort())
  })

  it('refuses buttons from an old message or revision', async () => {
    const r = await videoUnderReview()
    await expect(
      approveVideo(r.id, { messageId: r.videoMsg, revision: r.revision - 1 }, { platforms: [] }),
    ).rejects.toBeInstanceOf(VideoNotReviewableError)
    await expect(
      approveVideo(r.id, { messageId: 1, revision: r.revision }, { platforms: [] }),
    ).rejects.toBeInstanceOf(VideoNotReviewableError)
    expect(await rejectVideo(r.id, { messageId: r.videoMsg, revision: r.revision })).toBe(true)
    expect(await rejectVideo(r.id, { messageId: r.videoMsg, revision: r.revision })).toBe(false)
  })

  it('keeps the video on a title edit and resends the review', async () => {
    const r = await videoUnderReview()
    const now = new Date(Date.now() + 11 * 60_000)
    expect(await unsentReviews(now)).not.toContain(r.id)
    expect(
      await applyEdit(r.id, { replyTo: r.scriptMsg }, { kind: 'title', text: '새 제목' }),
    ).toEqual({
      ok: true,
      rerender: false,
    })
    const v = await loadVideo(r.id)
    expect(v).toMatchObject({
      status: 'PENDING_REVIEW',
      title: '새 제목',
      revision: r.revision + 1,
    })
    // The old messages now show an older revision: their buttons and replies are stale.
    expect(
      await applyEdit(r.id, { replyTo: r.scriptMsg }, { kind: 'title', text: 'x' }),
    ).toMatchObject({
      ok: false,
    })
    expect(await unsentReviews(now)).toContain(r.id)
  })

  it('validates edits without changing anything', async () => {
    const r = await videoUnderReview()
    const res = await applyEdit(
      r.id,
      { replyTo: r.videoMsg },
      { kind: 'narration', idx: 9, text: 'x.' },
    )
    expect(res).toEqual({ ok: false, message: '9번 장면이 없어요. 이 원고는 장면 3개예요.' })
    expect((await loadVideo(r.id))?.revision).toBe(r.revision)
  })
})

describe('approval', () => {
  it('creates every publication at one slot in a single step, one video per day', async () => {
    const a = await approved(['REELS', 'SHORTS'])
    expect(a.pubs.map((p) => p.platform)).toEqual(['REELS', 'SHORTS'])
    expect((await loadVideo(a.id))?.status).toBe('APPROVED')
    const b = await approved(['REELS', 'SHORTS'])
    expect(a.approval.at).not.toBeNull()
    expect(b.approval.at?.getTime()).toBe((a.approval.at?.getTime() ?? 0) + 86_400_000)
    const [acc] = await query<{ account_user_id: string }>(
      'select account_user_id from video_publications where id = $1',
      [a.pubs[0]?.id],
    )
    expect(acc?.account_user_id).toBe('dry-run')
  })

  it('approves without publications when no platform is automatic', async () => {
    const a = await approved([])
    expect(a.approval).toEqual({ at: null, platforms: [] })
    expect(a.pubs).toEqual([])
  })
})

describe('Reels publishing', () => {
  it('publishes and completes the video', async () => {
    const a = await approved(['REELS'])
    const ig = new FakeInstagram()
    ig.finishAfterPolls = 1
    const out = await publishPublication(a.pubs[0]?.id ?? 0, { instagram: ig, ...noSleep })
    expect(out).toMatchObject({ kind: 'published', mediaId: 'mc1' })
    expect(await pub(a.pubs[0]?.id ?? 0)).toMatchObject({ status: 'PUBLISHED', container_id: 'c1' })
    expect((await loadVideo(a.id))?.status).toBe('PUBLISHED')
    expect(await publishPublication(a.pubs[0]?.id ?? 0, { instagram: ig })).toEqual({
      kind: 'skipped',
    })
  })

  it('treats a lost publish response as published and recovers the media id', async () => {
    const a = await approved(['REELS'])
    const ig = new FakeInstagram()
    ig.loseResponse = true
    const out = await publishPublication(a.pubs[0]?.id ?? 0, { instagram: ig, ...noSleep })
    expect(out).toMatchObject({ kind: 'published', mediaId: 'mc1' })
    expect(ig.publishCalls).toEqual(['c1'])
  })

  it('does not count a slow container as a failure and reuses it next time', async () => {
    const a = await approved(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const ig = new FakeInstagram()
    ig.neverFinish = true
    let t = Date.now()
    const clock = () => (t += 60_000)
    expect(await publishPublication(id, { instagram: ig, clock, ...noSleep })).toEqual({
      kind: 'processing',
    })
    expect(await pub(id)).toMatchObject({ status: 'SCHEDULED', attempts: 0, container_id: 'c1' })
    ig.neverFinish = false
    expect((await publishPublication(id, { instagram: ig, ...noSleep })).kind).toBe('published')
    expect(ig.created).toEqual(['c1'])
  })

  it('fails at once on a rejected token', async () => {
    const a = await approved(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const ig = new FakeInstagram()
    ig.createError = new InstagramApiError('expired', 400, '', 190)
    expect(await publishPublication(id, { instagram: ig, ...noSleep })).toMatchObject({
      kind: 'failed',
      errorKind: 'auth',
    })
    expect((await unalertedFailures()).map((f) => f.id)).toContain(id)
  })

  it('retries ordinary errors and fails after three attempts', async () => {
    const a = await approved(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const ig = new FakeInstagram()
    ig.createError = new Error('500')
    expect((await publishPublication(id, { instagram: ig })).kind).toBe('retry')
    expect((await publishPublication(id, { instagram: ig })).kind).toBe('retry')
    expect(await publishPublication(id, { instagram: ig })).toMatchObject({
      kind: 'failed',
      errorKind: 'other',
    })
  })

  it('writes nothing after losing the claim', async () => {
    const a = await approved(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const ig = new FakeInstagram()
    const create = ig.createReelContainer.bind(ig)
    ig.createReelContainer = async (p) => {
      await query('update video_publications set claim_seq = claim_seq + 1 where id = $1', [id])
      return create(p)
    }
    expect(await publishPublication(id, { instagram: ig, ...noSleep })).toEqual({ kind: 'skipped' })
    expect(ig.publishCalls).toEqual([])
    expect((await pub(id)).container_id).toBeNull()
  })
})

describe('Shorts publishing', () => {
  const shorts = async () => {
    const a = await approved(['SHORTS'])
    return { ...a, id: a.pubs[0]?.id ?? 0 }
  }

  it('uploads with the publication tag and stores the Shorts link', async () => {
    const s = await shorts()
    const yt = new FakeYouTube()
    const out = await publishPublication(s.id, { youtube: yt, storage: s.storage })
    expect(out).toMatchObject({
      kind: 'published',
      mediaId: 'yt1',
      permalink: 'https://youtube.com/shorts/yt1',
    })
    expect(yt.videos[0]?.tags).toContain(`capub${s.id}`)
  })

  it('resumes an interrupted upload from the stored offset', async () => {
    const s = await shorts()
    const yt = new FakeYouTube()
    yt.dropAfterBytes = 4
    expect((await publishPublication(s.id, { youtube: yt, storage: s.storage })).kind).toBe('retry')
    expect((await pub(s.id)).upload_url).toBe('https://upload/s1')
    expect((await publishPublication(s.id, { youtube: yt, storage: s.storage })).kind).toBe(
      'published',
    )
    expect(yt.uploads.map((u) => u.from)).toEqual([0, 4])
  })

  it('finds a finished upload by its tag after the session expired, without uploading again', async () => {
    const s = await shorts()
    const yt = new FakeYouTube()
    yt.loseResponse = true
    expect((await publishPublication(s.id, { youtube: yt, storage: s.storage })).kind).toBe('retry')
    yt.expired.add('https://upload/s1')
    expect(await publishPublication(s.id, { youtube: yt, storage: s.storage })).toMatchObject({
      kind: 'published',
      mediaId: 'yt1',
    })
    expect(yt.videos).toHaveLength(1)
  })

  it('stops on an expired session without an upload until the owner retries', async () => {
    const s = await shorts()
    const yt = new FakeYouTube()
    yt.dropAfterBytes = 0
    await publishPublication(s.id, { youtube: yt, storage: s.storage })
    yt.expired.add('https://upload/s1')
    expect(await publishPublication(s.id, { youtube: yt, storage: s.storage })).toMatchObject({
      kind: 'failed',
      errorKind: 'session',
    })
    expect(yt.sessions.size).toBe(1)
    const at = await retryPublication(s.id)
    expect(at).not.toBeNull()
    expect(await pub(s.id)).toMatchObject({ status: 'SCHEDULED', upload_url: null, attempts: 0 })
    expect((await publishPublication(s.id, { youtube: yt, storage: s.storage })).kind).toBe(
      'published',
    )
    expect(yt.sessions.size).toBe(2)
  })
})

describe('sweeps and maintenance', () => {
  it('moves overdue publications to the next slot instead of sending them late', async () => {
    const a = await approved(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    await query(
      "update video_publications set scheduled_at = now() - interval '7 hours' where id = $1",
      [id],
    )
    const b = await approved(['REELS'])
    const dueId = b.pubs[0]?.id ?? 0
    await query(
      "update video_publications set scheduled_at = now() - interval '1 hour' where id = $1",
      [dueId],
    )
    expect(await duePublications()).toEqual({ due: [dueId], overdue: [id] })
    const at = await reschedulePublication(id, 'SCHEDULED')
    expect(at && at > new Date()).toBe(true)
  })

  it('expires old reviews and recovers stuck stages twice before failing them', async () => {
    const r = await videoUnderReview()
    await query("update videos set updated_at = now() - interval '73 hours' where id = $1", [r.id])
    expect((await expireVideos()).map((e) => e.id)).toEqual([r.id])

    const postId = await seedPublishedPost()
    const id = ((await createVideo(postId)) as { created: number }).created
    const age = () =>
      query("update videos set updated_at = now() - interval '1 hour' where id = $1", [id])
    await age()
    expect((await recoverStuckStages()).retry).toEqual([{ id, status: 'SCRIPTING', seq: 1 }])
    // The recovery bumped updated_at, so the next sweep waits again.
    expect((await recoverStuckStages()).retry).toEqual([])
    await age()
    expect((await recoverStuckStages()).retry).toHaveLength(1)
    await age()
    expect((await recoverStuckStages()).failed).toEqual([id])
    expect((await loadVideo(id))?.status).toBe('FAILED')
  })

  it('cleans up files of ended videos only', async () => {
    const rejected = await videoUnderReview()
    await rejectVideo(rejected.id, { revision: rejected.revision })
    await query("update videos set updated_at = now() - interval '4 days' where id = $1", [
      rejected.id,
    ])
    const kept = await approved([])
    await query("update videos set updated_at = now() - interval '40 days' where id = $1", [
      kept.id,
    ])
    const storage = new FakeStorage()
    expect(await cleanupVideoFiles(new Date(), storage)).toEqual({ deleted: 1, failed: 0 })
    expect((await loadVideo(rejected.id))?.video_url).toBeNull()
    expect((await loadVideo(kept.id))?.video_url).not.toBeNull()
  })

  it('collects insights for real publications and reports the latest snapshot', async () => {
    const a = await approved(['SHORTS'])
    await query(
      `update video_publications set status = 'PUBLISHED', platform_media_id = 'yt9',
         published_at = now() where id = $1`,
      [a.pubs[0]?.id],
    )
    expect(await collectVideoInsights(new Date(), { youtube: new FakeYouTube() })).toEqual({
      collected: 1,
      empty: 0,
      failed: 0,
    })
    expect(await loadVideoReportRows()).toEqual([
      { platform: 'SHORTS', title: '영상 제목', views: 50, likes: 5 },
    ])
  })

  it('schedules dry-run publications again after the switch', async () => {
    const a = await approved(['REELS'])
    await publishPublication(a.pubs[0]?.id ?? 0, { instagram: new FakeInstagram(), ...noSleep })
    await query("update video_publications set platform_media_id = 'dry-ig-1' where id = $1", [
      a.pubs[0]?.id,
    ])
    expect(await resetDryRun(a.id)).not.toBeNull()
    expect(await pub(a.pubs[0]?.id ?? 0)).toMatchObject({
      status: 'SCHEDULED',
      platform_media_id: null,
    })
    expect((await loadVideo(a.id))?.status).toBe('APPROVED')
  })
})

describe('pick', () => {
  it('prefers the most viewed eligible post and respects the weekly cap', async () => {
    await seedPublishedPost({ views: 10 })
    const best = await seedPublishedPost({ views: 500 })
    await seedPublishedPost({ views: 9000, mediaId: 'dry-post-1' })
    await seedPublishedPost({ views: 9000, origin: 'digest' })
    await seedPublishedPost({ views: 9000, daysAgo: 30 })
    // Without insights: still a candidate, after the measured ones.
    await seedPublishedPost()
    await seedPublishedPost()
    expect(await bestCandidate()).toBe(best)
    for (let i = 0; i < 3; i++) {
      expect((await pickVideo()).kind).toBe('created')
    }
    expect(await pickVideo()).toMatchObject({
      kind: 'skipped',
      reason: expect.stringMatching(/한도/),
    })
  })
})
