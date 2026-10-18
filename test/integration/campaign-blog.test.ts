import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBrowserAgent } from '../fake-browser.ts'
import { getCampaign, getPhotos, seedBlogCampaign, seedPhotos } from './campaign-helpers-blog.ts'

const DISCLOSURE = '본 포스팅은 레뷰를 통해 제품을 무상으로 제공받아 작성한 솔직한 후기입니다.'

const chatJson = vi.fn()
vi.mock('../../src/llm/openrouter.ts', () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}))
vi.mock('../../src/campaigns/profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/campaigns/profile.ts')>()
  const profile = actual.parseCampaignProfile({
    blog: { url: 'https://blog.naver.com/me', topic: 'IT', tone: '친근한 해요체' },
    types: ['delivery'],
    interests: [],
    excludeKeywords: [],
    applyMessage: { maxChars: 300, points: [] },
    disclosure: DISCLOSURE,
  })
  return { ...actual, loadCampaignProfile: async () => profile }
})

const blog = await import('../../src/campaigns/blog.ts')
const { saveBlogDraft } = await import('../../src/campaigns/blog-save.ts')
const { downloadPhotos } = await import('../../src/campaigns/photos.ts')

const BODY = `${'무선이어폰 노이즈캔슬링 후기를 정리했어요. '.repeat(10)}\n\n[사진1]`
const llm = (body = BODY, title = '무선이어폰 후기') => ({ title, body, usedKeywords: [] })

beforeEach(() => chatJson.mockReset())

describe('intake', () => {
  it('moves SELECTED to RECEIVED once', async () => {
    const id = await seedBlogCampaign({ status: 'SELECTED' })
    expect(await blog.markReceived(id)).toBe(true)
    expect(await blog.markReceived(id)).toBe(false)
    const c = await getCampaign(id)
    expect(c.status).toBe('RECEIVED')
    expect(c.received_at).not.toBeNull()
  })

  it('stores the intake message id and memo', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED' })
    expect(await blog.startIntake(id, 555)).toBe(true)
    expect(await blog.saveMemo(id, '  음질이 좋아요  ')).toBe(true)
    const c = await getCampaign(id)
    expect(c.intake_message_id).toBe(555)
    expect(c.memo).toBe('음질이 좋아요')
  })

  it('does not take intake input for a campaign that is not drafting', async () => {
    const id = await seedBlogCampaign({ status: 'APPLIED' })
    expect(await blog.startIntake(id, 1)).toBe(false)
    expect(await blog.saveMemo(id, 'x')).toBe(false)
    expect(await blog.addPhoto(id, 'f', 'u')).toBe(false)
  })

  it('stores photos in arrival order and dedupes by file_unique_id', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED' })
    expect(await blog.addPhoto(id, 'f1', 'u1')).toBe(true)
    expect(await blog.addPhoto(id, 'f2', 'u2')).toBe(true)
    expect(await blog.addPhoto(id, 'f1-again', 'u1')).toBe(false)
    expect((await getPhotos(id)).map((p) => [p.idx, p.file_id])).toEqual([
      [1, 'f1'],
      [2, 'f2'],
    ])
  })

  it('keeps every photo of a media group arriving concurrently', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED' })
    const results = await Promise.all([1, 2, 3, 4].map((n) => blog.addPhoto(id, `f${n}`, `u${n}`)))
    expect(results.every(Boolean)).toBe(true)
    expect((await getPhotos(id)).map((p) => p.idx)).toEqual([1, 2, 3, 4])
  })
})

describe('generateBlogDraft', () => {
  it('writes the draft with the disclosure first and bumps the revision', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED', memo: '좋아요' })
    await seedPhotos(id, 2)
    chatJson.mockResolvedValueOnce(llm())
    expect(await blog.generateBlogDraft(id)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_REVIEW')
    expect(c.revision).toBe(1)
    expect(c.draft_title).toBe('무선이어폰 후기')
    expect(c.draft_body?.startsWith(`${DISCLOSURE}\n\n`)).toBe(true)
    // The model forgot [사진2]; code adds it.
    expect(c.draft_body).toContain('[사진2]')
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('retries once when required keywords are missing and keeps the better result', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED', memo: 'm' })
    chatJson
      .mockResolvedValueOnce(llm(`${'무선이어폰만 말합니다. '.repeat(20)}`))
      .mockResolvedValueOnce(llm(BODY))
    await blog.generateBlogDraft(id)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(chatJson.mock.calls[1]?.[0].user).toContain('노이즈캔슬링')
    expect((await getCampaign(id)).draft_body).toContain('노이즈캔슬링')
  })

  it('does not draft a campaign past review', async () => {
    const id = await seedBlogCampaign({ status: 'DRAFT_APPROVED', draftBody: 'x' })
    expect(await blog.generateBlogDraft(id)).toBe(false)
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('drops a stale regeneration so it cannot clobber a newer one', async () => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_REVIEW',
      draftTitle: 'old',
      draftBody: 'old body',
      revision: 1,
      memo: 'm',
    })
    const first = await blog.requestDraftRegeneration(id)
    const second = await blog.requestDraftRegeneration(id)
    expect([first, second]).toEqual([1, 2])
    chatJson.mockResolvedValue(llm())
    expect(await blog.generateBlogDraft(id, { seq: 1, feedback: 'a' })).toBe(false)
    expect((await getCampaign(id)).draft_body).toBe('old body')
    expect(await blog.generateBlogDraft(id, { seq: 2, feedback: 'b' })).toBe(true)
    expect((await getCampaign(id)).revision).toBe(2)
  })

  it('has no regeneration request outside DRAFT_REVIEW', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED' })
    expect(await blog.requestDraftRegeneration(id)).toBeNull()
  })
})

describe('review edits and approval', () => {
  it('replaces the body verbatim but keeps the disclosure first, and the title alone', async () => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_REVIEW',
      draftTitle: 't',
      draftBody: 'b',
      revision: 1,
      reviewMessageId: 900,
    })
    expect(await blog.replaceDraft(id, 900, { body: '내가 쓴 본문 [사진1]' })).toBe(true)
    let c = await getCampaign(id)
    expect(c.draft_body).toBe(`${DISCLOSURE}\n\n내가 쓴 본문 [사진1]`)
    expect(c.draft_title).toBe('t')
    expect(c.revision).toBe(2)
    expect(await blog.replaceDraft(id, 900, { title: '새 제목' })).toBe(true)
    c = await getCampaign(id)
    expect(c.draft_title).toBe('새 제목')
    expect(c.draft_body).toBe(`${DISCLOSURE}\n\n내가 쓴 본문 [사진1]`)
    expect(c.revision).toBe(3)
  })

  it('ignores an edit to a message that is not the current card', async () => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_REVIEW',
      draftTitle: 't',
      draftBody: 'b',
      revision: 1,
      reviewMessageId: 900,
    })
    expect(await blog.replaceDraft(id, 901, { body: 'x' })).toBe(false)
  })

  it('approves only the revision the owner saw', async () => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_REVIEW',
      draftTitle: 't',
      draftBody: 'b',
      revision: 3,
      attempts: 2,
    })
    expect(await blog.approveDraft(id, 2)).toBe(false)
    expect((await getCampaign(id)).status).toBe('DRAFT_REVIEW')
    expect(await blog.approveDraft(id, 3)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_APPROVED')
    expect(c.attempts).toBe(0)
    expect(await blog.approveDraft(id, 3)).toBe(false)
  })

  it('retries a failed save only from DRAFT_FAILED', async () => {
    const failed = await seedBlogCampaign({ status: 'DRAFT_FAILED', draftBody: 'b', attempts: 3 })
    expect(await blog.retryDraftSave(failed)).toBe(true)
    expect((await getCampaign(failed)).attempts).toBe(0)
    expect(await blog.retryDraftSave(failed)).toBe(false)
  })
})

describe('markPosted', () => {
  it('records the blog url for a saved draft', async () => {
    const id = await seedBlogCampaign({ status: 'DRAFT_SAVED', draftBody: 'b' })
    expect(await blog.markPosted(id, 'https://blog.naver.com/me/223')).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('POSTED')
    expect(c.blog_url).toBe('https://blog.naver.com/me/223')
    expect(c.posted_at).not.toBeNull()
  })

  it('rejects other hosts and drafts that are not saved', async () => {
    const id = await seedBlogCampaign({ status: 'DRAFT_SAVED', draftBody: 'b' })
    await expect(blog.markPosted(id, 'https://example.com/x')).rejects.toThrow()
    expect((await getCampaign(id)).status).toBe('DRAFT_SAVED')
    const other = await seedBlogCampaign({ status: 'DRAFT_REVIEW', draftBody: 'b' })
    expect(await blog.markPosted(other, 'https://blog.naver.com/me/1')).toBe(false)
  })
})

describe('downloadPhotos', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-photos-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('downloads in idx order, records local_path and skips existing files', async () => {
    const id = await seedBlogCampaign({ status: 'RECEIVED' })
    await seedPhotos(id, 2)
    const fetchFile = vi.fn(async (fileId: string) => Buffer.from(fileId))
    const paths = await downloadPhotos(id, { dir, fetchFile })
    expect(paths).toHaveLength(2)
    expect(paths.every((p) => existsSync(p))).toBe(true)
    expect((await getPhotos(id)).map((p) => p.local_path)).toEqual(paths)
    expect(fetchFile).toHaveBeenCalledTimes(2)

    expect(await downloadPhotos(id, { dir, fetchFile })).toEqual(paths)
    expect(fetchFile).toHaveBeenCalledTimes(2)
  })
})

describe('saveBlogDraft', () => {
  let dir: string
  const fetchFile = async (fileId: string) => Buffer.from(fileId)
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-save-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const approved = async (opts: { attempts?: number } = {}) => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_APPROVED',
      draftTitle: '제목',
      draftBody: `${DISCLOSURE}\n\n본문 [사진1]`,
      revision: 2,
      attempts: opts.attempts,
    })
    await seedPhotos(id, 1)
    return id
  }

  it('saves the draft through the agent and never publishes', async () => {
    const id = await approved()
    const agent = new FakeBrowserAgent()
    agent.taskResults.push('편집기 열기...\nRESULT: SAVED')
    const outcome = await saveBlogDraft(id, agent, { dir, fetchFile })
    expect(outcome.kind).toBe('saved')
    const c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_SAVED')
    expect(c.draft_saved_at).not.toBeNull()
    expect(c.attempts).toBe(1)
    expect(agent.calls).toHaveLength(1)
    expect(agent.calls[0]?.opts?.sideEffect).toBe(true)
    expect(agent.calls[0]?.input).toContain('제목')
    expect(agent.calls[0]?.input).toContain('절대 발행하지 마라')
    expect((await getPhotos(id))[0]?.local_path).toBeTruthy()
  })

  it('goes back to DRAFT_APPROVED on a failed or unknown result, then DRAFT_FAILED after the last attempt', async () => {
    const id = await approved()
    const agent = new FakeBrowserAgent()
    agent.taskResults.push('RESULT: FAILED 저장 버튼 없음', '뭔가 했음', new Error('timeout'))
    expect((await saveBlogDraft(id, agent, { dir, fetchFile })).kind).toBe('retry')
    let c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_APPROVED')
    expect(c.last_error).toContain('저장 버튼 없음')

    expect((await saveBlogDraft(id, agent, { dir, fetchFile })).kind).toBe('retry')
    const last = await saveBlogDraft(id, agent, { dir, fetchFile })
    expect(last.kind).toBe('failed')
    c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_FAILED')
    expect(c.attempts).toBe(3)
    expect(c.last_error).toContain('timeout')
  })

  it('records a dry run as DRAFT_FAILED without saving', async () => {
    const id = await approved()
    const outcome = await saveBlogDraft(id, new FakeBrowserAgent(true), { dir, fetchFile })
    expect(outcome.kind).toBe('dry-run')
    const c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_FAILED')
    expect(c.last_error).toBe('드라이런: 저장하지 않음')
  })

  it('skips a campaign that is not approved or is claimed by someone else', async () => {
    const review = await seedBlogCampaign({ status: 'DRAFT_REVIEW', draftBody: 'b' })
    const fresh = await seedBlogCampaign({ status: 'DRAFT_SAVING', draftBody: 'b' })
    const agent = new FakeBrowserAgent()
    expect((await saveBlogDraft(review, agent, { dir, fetchFile })).kind).toBe('skipped')
    expect((await saveBlogDraft(fresh, agent, { dir, fetchFile })).kind).toBe('skipped')
    expect(agent.calls).toHaveLength(0)
  })

  it('resumes a stale DRAFT_SAVING row', async () => {
    const id = await seedBlogCampaign({
      status: 'DRAFT_SAVING',
      draftTitle: '제목',
      draftBody: '본문',
      attempts: 1,
      updatedAgoMinutes: 30,
    })
    const agent = new FakeBrowserAgent()
    agent.taskResults.push('RESULT: SAVED')
    expect((await saveBlogDraft(id, agent, { dir, fetchFile })).kind).toBe('saved')
    expect((await getCampaign(id)).attempts).toBe(2)
  })

  it('writes nothing when the claim was taken over during the save', async () => {
    const id = await approved()
    const agent = new FakeBrowserAgent()
    const { query } = await import('../../src/db/pool.ts')
    // The sweep re-claims the row while the agent works: claim_seq moves on.
    const run = agent.runTask.bind(agent)
    agent.runTask = async (task, opts) => {
      await query('update campaigns set claim_seq = claim_seq + 1 where id = $1', [id])
      return run(task, opts)
    }
    agent.taskResults.push('RESULT: SAVED')
    const outcome = await saveBlogDraft(id, agent, { dir, fetchFile })
    expect(outcome.kind).toBe('skipped')
    expect((await getCampaign(id)).status).toBe('DRAFT_SAVING')
  })
})
