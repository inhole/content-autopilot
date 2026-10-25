import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { createVideoActions } from '../../src/video/actions.ts'
import {
  approveVideo,
  cancelPublication,
  publishPublicationNow,
  retryFailedPublication,
} from '../../src/video/approve.ts'
import { reclaimUploadAttempts } from '../../src/video/cleanup.ts'
import { videosThisWeek } from '../../src/video/pick.ts'
import { type UploadInfo, UploadRejected } from '../../src/video/probe.ts'
import { publishPublication } from '../../src/video/publish.ts'
import { runFfmpeg } from '../../src/video/render.ts'
import {
  applyEdit,
  applyMetaEdit,
  expireUploads,
  loadVideo,
  markManualPublished,
  requestRescript,
  restartVideo,
  unapproveVideo,
} from '../../src/video/store.ts'
import type { Platform } from '../../src/video/types.ts'
import {
  createUpload,
  type FileDeps,
  receiveUpload,
  UPLOAD_TMP_ROOT,
  UploadBusyError,
  UploadTooLargeError,
} from '../../src/video/upload.ts'
import { createDashboardServer } from '../../src/web/server.ts'
import { loadVideoDetail, loadVideoList } from '../../src/web/video-data.ts'
import { fakeActions } from '../fake-actions.ts'
import { CSRF, fakeAuth, SESSION_HEADERS } from '../fake-auth.ts'
import { fakePostActions } from '../fake-post-actions.ts'
import { FakeInstagram, FakeStorage } from '../fake-video.ts'

const INFO: UploadInfo = {
  durationMs: 20_000,
  width: 1080,
  height: 1920,
  container: 'mp4',
  videoCodec: 'h264',
  hasAudio: true,
  videoIndex: 0,
  audioIndex: 1,
}

/** Skips ffmpeg: writes the "remuxed" file and returns fixed info. */
const fakePrepare: NonNullable<FileDeps['prepare']> = async (_input, output) => {
  await writeFile(output, 'remuxed')
  return INFO
}

const META = { title: '내가 만든 영상', caption: '직접 찍었어.', hashtags: ['AI'] }

async function newUpload(over: Partial<Parameters<typeof createUpload>[0]> = {}) {
  const r = await createUpload({ ...META, sourceUrl: null, originalName: 'clip.mp4', ...over })
  if (!r.ok) throw new Error(r.message)
  return r.id
}

const body = (bytes = 'x'.repeat(100)) => Readable.from([Buffer.from(bytes)])

function deps(over: Partial<FileDeps> = {}) {
  const reviews: number[] = []
  const storage = new FakeStorage()
  const d: FileDeps = {
    storage,
    enqueueReview: async (id) => {
      reviews.push(id)
    },
    prepare: fakePrepare,
    ...over,
  }
  return { d, reviews, storage: (over.storage as FakeStorage | undefined) ?? storage }
}

const attempts = async () =>
  (
    await query<{ key: string; reclaiming: boolean }>(
      'select key, reclaiming from video_upload_attempts',
    )
  ).map((r) => r)

/** Stored and under review. */
async function stored(): Promise<{ id: number; storage: FakeStorage }> {
  const id = await newUpload()
  const { d, storage } = deps()
  expect((await receiveUpload(id, body(), { approve: false }, d)).kind).toBe('stored')
  return { id, storage }
}

/** Stored and approved for `platforms`. */
async function approvedUpload(platforms: Platform[]) {
  const s = await stored()
  const v = await loadVideo(s.id)
  await approveVideo(s.id, { revision: v?.revision ?? 0 }, { platforms })
  const pubs = await query<{ id: number; platform: Platform }>(
    'select id, platform from video_publications where video_id = $1 order by id',
    [s.id],
  )
  return { ...s, pubs }
}

describe('upload rows', () => {
  it('creates an UPLOADING row without a post, checking title, caption and hashtags', async () => {
    const id = await newUpload({ sourceUrl: 'https://example.com/a' })
    expect(await loadVideo(id)).toMatchObject({
      origin: 'upload',
      post_id: null,
      status: 'UPLOADING',
      title: '내가 만든 영상',
      source_label: 'example.com',
      original_name: 'clip.mp4',
    })
    expect(
      await createUpload({ ...META, title: ' ', sourceUrl: null, originalName: null }),
    ).toEqual({
      ok: false,
      message: '제목을 넣어 주세요.',
    })
    const tags = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(
      await createUpload({ ...META, hashtags: tags, sourceUrl: null, originalName: null }),
    ).toMatchObject({ ok: false, message: '해시태그는 5개까지예요.' })
  })

  it('does not count uploads in the weekly cap of generated videos', async () => {
    await newUpload()
    await newUpload()
    expect(await videosThisWeek()).toBe(0)
  })
})

describe('file step', () => {
  it('stores the checked file, moves to review and queues the Telegram review', async () => {
    const id = await newUpload()
    const { d, reviews, storage } = deps()
    expect(await receiveUpload(id, body(), { approve: false }, d)).toEqual({
      kind: 'stored',
      approval: null,
    })
    const v = await loadVideo(id)
    expect(v).toMatchObject({
      status: 'PENDING_REVIEW',
      duration_ms: 20_000,
      width: 1080,
      height: 1920,
      size_bytes: 7,
    })
    expect(v?.video_url).toBe(`https://storage.test/${v?.storage_key}`)
    expect(storage.files.has(v?.storage_key ?? '')).toBe(true)
    expect(reviews).toEqual([id])
    expect(await attempts()).toEqual([])
    // A second request finds the row taken.
    expect(await receiveUpload(id, body(), { approve: false }, d)).toEqual({
      kind: 'not_uploading',
      status: 'PENDING_REVIEW',
    })
  })

  it('approves in the same request, or keeps the file and queues the review when that fails', async () => {
    const ok = await newUpload()
    const a = deps({ approve: (id, g) => approveVideo(id, g, { platforms: [] }) })
    const r = await receiveUpload(ok, body(), { approve: true }, a.d)
    expect(r).toEqual({
      kind: 'stored',
      approval: { ok: true, approval: { at: null, platforms: [] } },
    })
    expect((await loadVideo(ok))?.status).toBe('APPROVED')
    expect(a.reviews).toEqual([])

    const failing = await newUpload()
    const b = deps({
      approve: async () => {
        throw new Error('Instagram 계정이 설정되지 않았어요')
      },
    })
    expect(await receiveUpload(failing, body(), { approve: true }, b.d)).toEqual({
      kind: 'stored',
      approval: { ok: false, error: 'Instagram 계정이 설정되지 않았어요' },
    })
    expect((await loadVideo(failing))?.status).toBe('PENDING_REVIEW')
    expect(b.reviews).toEqual([failing])
  })

  it('keeps the row UPLOADING after a rejected file, so another file can follow', async () => {
    const id = await newUpload()
    const { d } = deps({
      prepare: async () => {
        throw new UploadRejected('세로 영상만 올릴 수 있어요')
      },
    })
    expect(await receiveUpload(id, body(), { approve: false }, d)).toEqual({
      kind: 'rejected',
      message: '세로 영상만 올릴 수 있어요',
    })
    expect((await loadVideo(id))?.status).toBe('UPLOADING')
    expect(await attempts()).toEqual([])
    expect((await receiveUpload(id, body(), { approve: false }, deps().d)).kind).toBe('stored')
  })

  it('stops at the size limit and leaves no temp folder', async () => {
    const id = await newUpload()
    const { d } = deps({ maxBytes: 10 })
    await expect(
      receiveUpload(id, body('y'.repeat(11)), { approve: false }, d),
    ).rejects.toBeInstanceOf(UploadTooLargeError)
    const left = await readdir(UPLOAD_TMP_ROOT).catch(() => [] as string[])
    expect(left.filter((n) => n.startsWith(`v${id}-`))).toEqual([])
    expect((await loadVideo(id))?.status).toBe('UPLOADING')
  })

  it('processes one upload at a time', async () => {
    const first = await newUpload()
    const second = await newUpload()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = deps({
      prepare: async (input, output, size) => {
        await gate
        return fakePrepare(input, output, size)
      },
    })
    const running = receiveUpload(first, body(), { approve: false }, slow.d)
    await new Promise((r) => setTimeout(r, 50))
    await expect(
      receiveUpload(second, body(), { approve: false }, deps().d),
    ).rejects.toBeInstanceOf(UploadBusyError)
    release()
    expect((await running).kind).toBe('stored')
    expect((await receiveUpload(second, body(), { approve: false }, deps().d)).kind).toBe('stored')
  })

  it('deletes its own file when the row stopped being UPLOADING meanwhile', async () => {
    const id = await newUpload()
    const storage = new FakeStorage()
    const upload = storage.upload.bind(storage)
    storage.upload = async (path, key) => {
      const url = await upload(path, key)
      await query("update videos set status = 'EXPIRED' where id = $1", [id])
      return url
    }
    const { d } = deps({ storage })
    expect(await receiveUpload(id, body(), { approve: false }, d)).toEqual({
      kind: 'not_uploading',
      status: 'EXPIRED',
    })
    expect(storage.removed).toHaveLength(1)
    expect(storage.files.size).toBe(0)
    expect(await attempts()).toEqual([])
  })

  it('never references an attempt that cleanup marked, and leaves its file to cleanup', async () => {
    const id = await newUpload()
    const storage = new FakeStorage()
    const upload = storage.upload.bind(storage)
    storage.upload = async (path, key) => {
      const url = await upload(path, key)
      await query('update video_upload_attempts set reclaiming = true where key = $1', [key])
      return url
    }
    const { d } = deps({ storage })
    expect(await receiveUpload(id, body(), { approve: false }, d)).toEqual({
      kind: 'not_uploading',
      status: 'UPLOADING',
    })
    expect((await loadVideo(id))?.video_url).toBeNull()
    expect(storage.removed).toEqual([])
    const later = new Date(Date.now() + 2 * 3600_000)
    expect(await reclaimUploadAttempts(later, storage)).toEqual({ deleted: 1, failed: 0 })
    expect(storage.files.size).toBe(0)
    expect(await attempts()).toEqual([])
  })

  it('leaves the attempt to cleanup when the storage upload fails', async () => {
    const id = await newUpload()
    const storage = new FakeStorage()
    storage.upload = async () => {
      throw new Error('storage timeout')
    }
    await expect(
      receiveUpload(id, body(), { approve: false }, deps({ storage }).d),
    ).rejects.toThrow('storage timeout')
    expect(await attempts()).toHaveLength(1)
    // Too young to reclaim yet.
    expect(await reclaimUploadAttempts(new Date(), storage)).toEqual({ deleted: 0, failed: 0 })
    const later = new Date(Date.now() + 2 * 3600_000)
    storage.remove = async () => {
      throw new Error('still down')
    }
    expect(await reclaimUploadAttempts(later, storage)).toEqual({ deleted: 0, failed: 1 })
    expect(await attempts()).toHaveLength(1)
    const ok = new FakeStorage()
    expect(await reclaimUploadAttempts(later, ok)).toEqual({ deleted: 1, failed: 0 })
    expect(await attempts()).toEqual([])
  })

  it('reclaims a referenced attempt without deleting the file', async () => {
    const s = await stored()
    const v = await loadVideo(s.id)
    await query(
      'insert into video_upload_attempts (key, video_id, created_at) values ($1, $2, $3)',
      [v?.storage_key, s.id, new Date(Date.now() - 2 * 3600_000)],
    )
    expect(await reclaimUploadAttempts(new Date(), s.storage)).toEqual({ deleted: 0, failed: 0 })
    expect(s.storage.removed).toEqual([])
    expect(await attempts()).toEqual([])
  })
})

describe('upload expiry', () => {
  it('expires a row an hour after its latest file request, not during one', async () => {
    const idle = await newUpload()
    const busy = await newUpload()
    await query("update videos set created_at = now() - interval '2 hours' where id in ($1, $2)", [
      idle,
      busy,
    ])
    await query(
      "update videos set upload_started_at = now() - interval '5 minutes' where id = $1",
      [busy],
    )
    expect(await expireUploads()).toEqual([idle])
    expect((await loadVideo(busy))?.status).toBe('UPLOADING')
  })
})

describe('review of uploads', () => {
  it('refuses the generated-only paths', async () => {
    const s = await stored()
    const v = await loadVideo(s.id)
    expect(await requestRescript(s.id, { revision: v?.revision ?? 0 }, '다시')).toBeNull()
    expect(
      await applyEdit(
        s.id,
        { revision: v?.revision ?? 0 },
        { kind: 'narration', idx: 1, text: '새 문장.' },
      ),
    ).toEqual({ ok: false, message: '직접 올린 영상은 장면을 고칠 수 없어요.' })
    // Title and caption replies work on uploads.
    expect(
      await applyEdit(s.id, { revision: v?.revision ?? 0 }, { kind: 'title', text: '새 제목' }),
    ).toEqual({
      ok: true,
      rerender: false,
    })
    await query("update videos set status = 'EXPIRED' where id = $1", [s.id])
    expect(await restartVideo(s.id)).toBeNull()
  })

  it('edits title, caption and hashtags together with one revision bump', async () => {
    const s = await stored()
    const before = (await loadVideo(s.id))?.revision ?? 0
    expect(
      await applyMetaEdit(
        s.id,
        { revision: before },
        {
          title: '바뀐 제목',
          caption: '바뀐 캡션.',
          hashtags: ['#개발', 'AI'],
        },
      ),
    ).toEqual({ ok: true })
    expect(await loadVideo(s.id)).toMatchObject({
      title: '바뀐 제목',
      caption: '바뀐 캡션.',
      hashtags: ['개발', 'AI'],
      revision: before + 1,
    })
    // The page that saw the old revision is stale; nothing is half-applied.
    expect(
      await applyMetaEdit(s.id, { revision: before }, { title: 'x', caption: 'y', hashtags: [] }),
    ).toMatchObject({ ok: false, stale: true })
    expect(
      await applyMetaEdit(
        s.id,
        { revision: before + 1 },
        { title: '', caption: 'y', hashtags: [] },
      ),
    ).toEqual({ ok: false, message: '제목을 넣어 주세요.' })
  })
})

describe('unapprove, cancel and guards', () => {
  it('takes back an approval only while no publication was attempted', async () => {
    const a = await approvedUpload(['REELS', 'SHORTS'])
    const rev = (await loadVideo(a.id))?.revision ?? 0
    expect(await unapproveVideo(a.id, rev - 1)).toMatchObject({ ok: false, stale: true })
    expect(await unapproveVideo(a.id, rev)).toEqual({ ok: true })
    expect(await loadVideo(a.id)).toMatchObject({ status: 'PENDING_REVIEW', revision: rev + 1 })
    expect(
      await query('select 1 from video_publications where video_id = $1', [a.id]),
    ).toHaveLength(0)

    const b = await approvedUpload(['REELS'])
    // Claimed once and back in SCHEDULED (Reels still processing): a container may exist.
    await query('update video_publications set claim_seq = 1 where video_id = $1', [b.id])
    const brev = (await loadVideo(b.id))?.revision ?? 0
    expect(await unapproveVideo(b.id, brev)).toMatchObject({
      ok: false,
      message: '이미 발행을 시작해서 승인을 취소할 수 없어요.',
    })
  })

  it('unapproves a manual approval and binds the manual-done button to the approved revision', async () => {
    const a = await approvedUpload([])
    const rev = (await loadVideo(a.id))?.revision ?? 0
    expect(await unapproveVideo(a.id, rev)).toEqual({ ok: true })
    await approveVideo(a.id, { revision: rev + 1 }, { platforms: [] })
    // The button from the first approval does nothing.
    expect(await markManualPublished(a.id, rev)).toBe(false)
    expect(await markManualPublished(a.id, rev + 1)).toBe(true)
    expect((await loadVideo(a.id))?.status).toBe('PUBLISHED')
  })

  it('finishes the video after a cancellation: published if one went out, failed if none', async () => {
    const a = await approvedUpload(['REELS', 'SHORTS'])
    const [reels, shorts] = a.pubs
    await query(
      "update video_publications set status = 'PUBLISHED', published_at = now(), platform_media_id = 'm1' where id = $1",
      [reels?.id],
    )
    await query(
      "update video_publications set status = 'FAILED', claim_seq = 3, error_kind = 'other' where id = $1",
      [shorts?.id],
    )
    expect(await cancelPublication(shorts?.id ?? 0, { claimSeq: 2 })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    expect(await cancelPublication(shorts?.id ?? 0, { claimSeq: 3 })).toEqual({
      ok: true,
      videoId: a.id,
      finished: 'PUBLISHED',
    })
    expect((await loadVideo(a.id))?.status).toBe('PUBLISHED')

    const b = await approvedUpload(['SHORTS'])
    await query(
      "update video_publications set status = 'FAILED', claim_seq = 1, error_kind = 'session' where video_id = $1",
      [b.id],
    )
    const id = b.pubs[0]?.id ?? 0
    expect(await cancelPublication(id, { claimSeq: 1 })).toMatchObject({ reason: 'confirm' })
    expect(await cancelPublication(id, { claimSeq: 1, confirmedNotOnChannel: true })).toMatchObject(
      {
        ok: true,
        finished: 'FAILED',
      },
    )
    expect(await loadVideo(b.id)).toMatchObject({ status: 'FAILED', published_at: null })
  })

  it('retries a failure only for the attempt the owner saw', async () => {
    const a = await approvedUpload(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    await query(
      "update video_publications set status = 'FAILED', claim_seq = 2, error_kind = 'other' where id = $1",
      [id],
    )
    expect(await retryFailedPublication(id, { claimSeq: 1 })).toMatchObject({ reason: 'stale' })
    expect(await retryFailedPublication(id, { claimSeq: 2 })).toMatchObject({ ok: true })
    // Already rescheduled: the same button again is stale.
    expect(await retryFailedPublication(id, { claimSeq: 2 })).toMatchObject({ reason: 'stale' })
  })

  it('moves one publication to now only from the slot the page showed', async () => {
    const a = await approvedUpload(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const [row] = await query<{ scheduled_at: Date }>(
      'select scheduled_at from video_publications where id = $1',
      [id],
    )
    const slot = row?.scheduled_at ?? new Date()
    expect(await publishPublicationNow(id, new Date(slot.getTime() + 1000))).toBe(false)
    expect(await publishPublicationNow(id, slot)).toBe(true)
    expect(await publishPublicationNow(id, slot)).toBe(false)
  })

  it('publishes an approved upload like a generated video', async () => {
    const a = await approvedUpload(['REELS'])
    const id = a.pubs[0]?.id ?? 0
    const [row] = await query<{ scheduled_at: Date }>(
      'select scheduled_at from video_publications where id = $1',
      [id],
    )
    await publishPublicationNow(id, row?.scheduled_at ?? new Date())
    const ig = new FakeInstagram()
    const out = await publishPublication(id, { instagram: ig, sleep: async () => {} })
    expect(out.kind).toBe('published')
    expect((await loadVideo(a.id))?.status).toBe('PUBLISHED')
    expect(ig.containers.get(ig.created[0] ?? '')?.caption).toBe('직접 찍었어.\n\n#AI')
  })
})

describe.skipIf(!ffmpegPath)('file route end to end (real HTTP, ffmpeg, DB)', () => {
  it('uploads a generated mp4 through the dashboard and approves it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-upload-e2e-'))
    const storage = new FakeStorage()
    const reviews: number[] = []
    const { auth } = fakeAuth()
    const server = createDashboardServer({
      auth,
      actions: fakeActions().actions,
      postActions: fakePostActions().actions,
      videoActions: createVideoActions({
        storage,
        enqueueReview: async (id) => {
          reviews.push(id)
        },
        enqueueScript: async () => {},
      }),
      runOps: async () => true,
      profileEdit: { save: async () => null, reset: async () => null },
      scheduleEdit: { save: async () => null, reset: async () => null },
      notify: async () => {},
      webDist: null,
      loaders: {
        overview: async () => {
          throw new Error('not used')
        },
        campaigns: async () => [],
        campaign: async () => null,
        posts: async () => [],
        insights: async (days) => ({ days, daily: [], top: [] }),
        post: async () => null,
        revivable: async () => ({ rows: [] }),
        ops: async () => {
          throw new Error('not used')
        },
        videos: (f) => loadVideoList(f),
        video: loadVideoDetail,
      },
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const headers = {
      ...SESSION_HEADERS,
      origin: base,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': CSRF,
    }
    try {
      const file = join(dir, 'clip.mp4')
      await runFfmpeg([
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'],
        ...['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'],
        file,
      ])
      const created = await fetch(`${base}/api/videos`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...META, sourceUrl: '', originalName: 'clip.mp4' }),
      })
      const { id } = (await created.json()) as { id: number }
      const res = await fetch(`${base}/api/videos/${id}/file?approve=1`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'video/mp4' },
        body: new Uint8Array(await readFile(file)),
      })
      const json = (await res.json()) as {
        approval: { ok: boolean }
        detail: { video: { status: string; width: number; height: number } }
      }
      expect(res.status).toBe(200)
      // No automatic platforms in tests: approved for a manual upload.
      expect(json.approval).toEqual({ ok: true, at: null, platforms: [] })
      expect(json.detail.video).toMatchObject({ status: 'APPROVED', width: 720, height: 1280 })
      expect(storage.files.size).toBe(1)
      expect(reviews).toEqual([])
      expect(await attempts()).toEqual([])
      // The same row cannot take a second file.
      const again = await fetch(`${base}/api/videos/${id}/file`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'video/mp4' },
        body: new Uint8Array(await readFile(file)),
      })
      expect(again.status).toBe(409)
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
