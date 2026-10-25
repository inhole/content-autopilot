import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { UploadBusyError } from '../src/video/upload.ts'
import { APP_CSP, createDashboardServer } from '../src/web/server.ts'
import { matchVideoRoute } from '../src/web/video-actions.ts'
import type { VideoDetailData } from '../src/web/video-data.ts'
import { fakeActions } from './fake-actions.ts'
import { CSRF, fakeAuth, SESSION_HEADERS } from './fake-auth.ts'
import { fakePostActions } from './fake-post-actions.ts'
import { fakeVideoActions } from './fake-video-actions.ts'

const { auth, state: authState } = fakeAuth()
const { actions: videoActions, state } = fakeVideoActions()
const listCalls: string[] = []

const detail = (id: number) =>
  ({
    video: { id, status: 'PENDING_REVIEW', revision: 2 },
    publications: [],
  }) as unknown as VideoDetailData

let base = ''
const server = createDashboardServer({
  auth,
  actions: fakeActions().actions,
  postActions: fakePostActions().actions,
  videoActions,
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
    videos: async (filter) => {
      listCalls.push(filter)
      return []
    },
    video: async (id) => (id === 41 ? detail(id) : null),
  },
})

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  state.calls.length = 0
  state.received.length = 0
  authState.actions.length = 0
  listCalls.length = 0
})

const writeHeaders = (extra: Record<string, string> = {}) => ({
  ...SESSION_HEADERS,
  origin: base,
  'sec-fetch-site': 'same-origin',
  'x-csrf-token': CSRF,
  ...extra,
})

const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: writeHeaders({ 'content-type': 'application/json', ...extra }),
    body: JSON.stringify(body),
  })

const upload = (path: string, bytes: Buffer, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: writeHeaders({ 'content-type': 'video/mp4', ...extra }),
    body: new Uint8Array(bytes),
  })

const lastAudit = () => authState.actions.at(-1)

describe('routes', () => {
  it('matches the video and publication POST routes only', () => {
    expect(matchVideoRoute('/api/videos')).toEqual({ kind: 'create' })
    expect(matchVideoRoute('/api/videos/7/file')).toEqual({ kind: 'file', id: 7 })
    expect(matchVideoRoute('/api/videos/7/approve')).toEqual({
      kind: 'video',
      id: 7,
      action: 'approve',
    })
    expect(matchVideoRoute('/api/videos/x/approve')).toEqual({
      kind: 'video',
      id: null,
      action: 'approve',
    })
    expect(matchVideoRoute('/api/publications/3/retry')).toMatchObject({
      kind: 'publication',
      id: 3,
    })
    expect(matchVideoRoute('/api/videos/7/delete')).toBeNull()
    expect(matchVideoRoute('/api/publications/3/approve')).toBeNull()
  })

  it('lets the player load from the dashboard (and the Supabase project when set)', () => {
    expect(APP_CSP).toMatch(/media-src 'self'/)
  })
})

describe('reads', () => {
  it('lists with the active filter by default and returns one video or 404', async () => {
    const list = await fetch(`${base}/api/videos?status=bogus`, { headers: SESSION_HEADERS })
    expect(await list.json()).toEqual({ filter: 'active', rows: [] })
    await fetch(`${base}/api/videos?status=all`, { headers: SESSION_HEADERS })
    expect(listCalls).toEqual(['active', 'all'])
    expect((await fetch(`${base}/api/videos/41`, { headers: SESSION_HEADERS })).status).toBe(200)
    expect((await fetch(`${base}/api/videos/42`, { headers: SESSION_HEADERS })).status).toBe(404)
    expect((await fetch(`${base}/api/videos/abc`, { headers: SESSION_HEADERS })).status).toBe(404)
    expect((await fetch(`${base}/api/videos`)).status).toBe(401)
  })
})

describe('create and actions', () => {
  it('creates an upload row and audits it without the text', async () => {
    const res = await post('/api/videos', {
      title: '제목',
      caption: '캡션',
      hashtags: ['AI'],
      sourceUrl: '',
      originalName: 'clip.mp4',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id: 41, revision: 1 })
    expect(state.calls[0]?.params).toMatchObject({ sourceUrl: null, originalName: 'clip.mp4' })
    expect(lastAudit()).toMatchObject({
      action: 'video.create',
      result: 'ok',
      detail: { videoId: 41 },
    })
    expect(JSON.stringify(lastAudit())).not.toContain('캡션')
    expect(
      (await post('/api/videos', { title: 'x', caption: 'y', hashtags: [], sourceUrl: 'ftp://a' }))
        .status,
    ).toBe(400)
  })

  it('runs an action on the displayed revision and maps stale, invalid and confirm', async () => {
    const ok = await post('/api/videos/41/approve', { revision: 2 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, telegramSynced: true, detail: detail(41) })
    expect(state.calls.at(-1)).toEqual({ name: 'approve', id: 41, params: { revision: 2 } })
    expect(lastAudit()).toMatchObject({ action: 'video.approve', target: 'video:41' })

    state.next = { ok: false, reason: 'stale', message: '바뀌었어요' }
    const stale = await post('/api/videos/41/unapprove', { revision: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: '바뀌었어요', stale: true })

    expect((await post('/api/videos/41/edit', { revision: 2, title: 'x' })).status).toBe(400)
    expect(
      (await post('/api/videos/41/edit', { revision: 2, title: 'x', caption: 'y', hashtags: [] }))
        .status,
    ).toBe(200)

    state.next = { ok: false, reason: 'confirm', message: '채널을 확인해 주세요' }
    const confirm = await post('/api/publications/5/retry', { claimSeq: 3 })
    expect(confirm.status).toBe(400)
    expect(await confirm.json()).toEqual({ error: '채널을 확인해 주세요', confirm: true })
    expect(lastAudit()).toMatchObject({
      action: 'publication.retry',
      target: 'publication:5',
      detail: { claimSeq: 3, confirmed: false },
    })

    expect((await post('/api/publications/404/cancel', { claimSeq: 1 })).status).toBe(404)
    expect((await post('/api/publications/5/publishNow', { scheduledAt: 'nope' })).status).toBe(400)
    const now = await post('/api/publications/5/publishNow', {
      scheduledAt: '2026-10-25T10:00:00.000Z',
    })
    expect(now.status).toBe(200)
  })

  it('refuses writes without the session, the CSRF token or the same origin', async () => {
    expect(
      (await post('/api/videos/41/approve', { revision: 2 }, { 'x-csrf-token': 'nope' })).status,
    ).toBe(403)
    expect(
      (await post('/api/videos/41/approve', { revision: 2 }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403)
    expect((await post('/api/videos/41/approve', { revision: 2 }, { Cookie: '' })).status).toBe(401)
    expect(state.calls).toEqual([])
    expect(
      (await fetch(`${base}/api/videos/41/approve`, { headers: SESSION_HEADERS })).status,
    ).toBe(405)
  })
})

describe('file route', () => {
  it('streams the body to the upload step and returns the detail', async () => {
    state.nextFile = {
      kind: 'stored',
      approval: {
        ok: true,
        approval: { at: new Date('2026-10-26T10:00:00Z'), platforms: ['REELS'] },
      },
      telegramSynced: true,
    }
    const res = await upload('/api/videos/41/file?approve=1', Buffer.alloc(3000, 1))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      approval: { ok: true, at: '2026-10-26T10:00:00.000Z', platforms: ['REELS'] },
      telegramSynced: true,
      detail: detail(41),
    })
    expect(state.received).toEqual([3000])
    expect(state.calls.at(-1)).toMatchObject({
      name: 'receiveFile',
      id: 41,
      params: { approve: true },
    })
    expect(lastAudit()).toMatchObject({
      action: 'video.file',
      result: 'ok',
      detail: { sizeBytes: 3000, approve: true, approved: true },
    })
  })

  it('maps the step outcomes: rejected 400, not uploading 409, busy 429', async () => {
    state.nextFile = { kind: 'rejected', message: '세로 영상만 올릴 수 있어요' }
    const rejected = await upload('/api/videos/41/file', Buffer.alloc(10))
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: '세로 영상만 올릴 수 있어요' })

    state.nextFile = { kind: 'not_uploading', status: 'PENDING_REVIEW' }
    const taken = await upload('/api/videos/41/file', Buffer.alloc(10))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ status: 'PENDING_REVIEW' })

    state.nextFile = new UploadBusyError()
    expect((await upload('/api/videos/41/file', Buffer.alloc(10))).status).toBe(429)
  })

  it('refuses the wrong type, foreign origins and missing CSRF before reading the body', async () => {
    expect(
      (await upload('/api/videos/41/file', Buffer.alloc(10), { 'content-type': 'image/png' }))
        .status,
    ).toBe(415)
    expect(
      (await upload('/api/videos/41/file', Buffer.alloc(10), { 'x-csrf-token': 'nope' })).status,
    ).toBe(403)
    expect(
      (await upload('/api/videos/41/file', Buffer.alloc(10), { origin: 'https://evil.example' }))
        .status,
    ).toBe(403)
    expect((await upload('/api/videos/41/file', Buffer.alloc(10), { Cookie: '' })).status).toBe(401)
    expect(state.calls).toEqual([])
  })

  it('answers 413 from Content-Length alone and closes the connection', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/videos/41/file`, {
        method: 'POST',
        headers: writeHeaders({
          'content-type': 'video/mp4',
          'content-length': String(500 * 1024 * 1024),
        }),
      })
      req.on('response', (res) => {
        resolve(res.statusCode ?? 0)
        res.resume()
      })
      req.on('error', reject)
      req.write(Buffer.alloc(1024))
    })
    expect(status).toBe(413)
    expect(state.calls).toEqual([])
    expect(lastAudit()).toMatchObject({ action: 'video.file', detail: { reason: 'too_large' } })
  })
})
