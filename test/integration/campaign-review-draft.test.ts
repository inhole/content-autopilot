import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatJson = vi.hoisted(() => vi.fn())
vi.mock('../../src/llm/openrouter.ts', () => ({ chatJson }))

import { parseCampaignProfile } from '../../src/campaigns/profile.ts'
import {
  generateReviewDraft,
  markControlSent,
  markPosted,
  replaceDraft,
  replaceDraftGuarded,
  requestDraftRegeneration,
  saveMemo,
  startIntake,
} from '../../src/campaigns/review-draft.ts'
import { getCampaign, seedCampaign, seedDraftCampaign } from './campaign-helpers-draft.ts'

const DISCLOSURE = '체험단으로 제품을 제공받아 작성한 솔직한 리뷰입니다.'
const profile = parseCampaignProfile({
  about: 'IT 개발자',
  interests: [],
  excludeKeywords: [],
  review: { tone: '담백하게', minChars: 10, maxChars: 500, points: [] },
  disclosure: DISCLOSURE,
})

vi.mock('../../src/campaigns/profile.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/campaigns/profile.ts')>()),
  loadCampaignProfile: async () => profile,
}))

beforeEach(() => chatJson.mockReset())

describe('intake and memo', () => {
  it('stores the intake message and the memo', async () => {
    const id = await seedCampaign()
    expect(await startIntake(id, 77)).toBe(true)
    expect(await saveMemo(id, '  일주일 썼고 좋았음  ')).toBe(true)
    const c = await getCampaign(id)
    expect([c.intake_message_id, c.memo]).toEqual([77, '일주일 썼고 좋았음'])
  })
  it('ignores other statuses and empty memos', async () => {
    const id = await seedCampaign({ status: 'APPLIED' })
    expect(await startIntake(id, 1)).toBe(false)
    expect(await saveMemo(id, 'x')).toBe(false)
    const selected = await seedCampaign()
    expect(await saveMemo(selected, '   ')).toBe(false)
  })
})

describe('generateReviewDraft', () => {
  it('returns false without a memo', async () => {
    const id = await seedCampaign()
    expect(await generateReviewDraft(id)).toBe(false)
    expect(chatJson).not.toHaveBeenCalled()
    expect((await getCampaign(id)).status).toBe('SELECTED')
  })
  it('writes the draft with the disclosure and bumps the revision', async () => {
    const id = await seedCampaign({ memo: '일주일 써봄' })
    chatJson.mockResolvedValue({ text: '일주일 써봤는데 괜찮았어요' })
    expect(await generateReviewDraft(id)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('DRAFT_REVIEW')
    expect(c.draft_text).toBe(`${DISCLOSURE}\n\n일주일 써봤는데 괜찮았어요`)
    expect(c.revision).toBe(1)
  })
  it('does not clobber a newer request with an older seq', async () => {
    const id = await seedCampaign({ memo: '메모' })
    const older = await requestDraftRegeneration(id)
    const newer = await requestDraftRegeneration(id)
    expect(newer).toBe((older ?? 0) + 1)
    chatJson.mockResolvedValue({ text: '오래된 요청의 결과입니다' })
    expect(await generateReviewDraft(id, { seq: older ?? 0 })).toBe(false)
    expect((await getCampaign(id)).draft_text).toBeNull()
    chatJson.mockResolvedValue({ text: '최신 요청의 결과입니다' })
    expect(await generateReviewDraft(id, { seq: newer ?? 0 })).toBe(true)
    expect((await getCampaign(id)).draft_text).toContain('최신 요청의 결과입니다')
  })
  it('does not write once the review was posted', async () => {
    const id = await seedDraftCampaign()
    chatJson.mockImplementation(async () => {
      const { query } = await import('../../src/db/pool.ts')
      await query("update campaigns set status = 'POSTED' where id = $1", [id])
      return { text: '늦게 도착한 초안입니다' }
    })
    expect(await generateReviewDraft(id)).toBe(false)
    expect((await getCampaign(id)).draft_text).toBe('초안입니다')
  })
  it('requestDraftRegeneration is null outside the review stages', async () => {
    const id = await seedCampaign({ status: 'POSTED' })
    expect(await requestDraftRegeneration(id)).toBeNull()
  })
})

describe('control message registration', () => {
  it('registers only when the revision is still current', async () => {
    const id = await seedDraftCampaign({
      revision: 3,
      review_message_id: null,
      review_revision: null,
    })
    expect(await markControlSent(id, 1, 300, 2)).toBe(false)
    expect((await getCampaign(id)).review_message_id).toBeNull()
    expect(await markControlSent(id, 1, 300, 3)).toBe(true)
    const c = await getCampaign(id)
    expect([c.review_message_id, c.review_revision]).toEqual([300, 3])
  })
})

describe('replaceDraft', () => {
  it('replaces the text, keeps the disclosure first and bumps the revision', async () => {
    const id = await seedDraftCampaign()
    const res = await replaceDraft(id, 200, '내가 고친 리뷰', profile)
    expect(res).toEqual({ ok: true, revision: 2 })
    const c = await getCampaign(id)
    expect(c.draft_text).toBe(`${DISCLOSURE}\n\n내가 고친 리뷰`)
    expect(c.review_revision).toBe(1)
  })
  it('makes a regeneration queued before the edit stale', async () => {
    const id = await seedDraftCampaign()
    const seq = await requestDraftRegeneration(id)
    expect(seq).not.toBeNull()
    await replaceDraft(id, 200, '내가 고친 리뷰', profile)
    chatJson.mockResolvedValue({ text: '예전 요청으로 다시 쓴 리뷰'.repeat(5) })
    // The queued job still carries the old seq, so it must not overwrite the owner's text.
    expect(await generateReviewDraft(id, { seq: seq ?? 0 })).toBe(false)
    expect((await getCampaign(id)).draft_text).toBe(`${DISCLOSURE}\n\n내가 고친 리뷰`)
  })
  it('does not duplicate a disclosure the owner kept', async () => {
    const id = await seedDraftCampaign()
    await replaceDraft(id, 200, `${DISCLOSURE}\n\n본문`, profile)
    expect((await getCampaign(id)).draft_text).toBe(`${DISCLOSURE}\n\n본문`)
  })
  it('refuses a stale message, an empty text and an over-long text', async () => {
    const id = await seedDraftCampaign()
    expect((await replaceDraft(id, 199, '글', profile)).ok).toBe(false)
    expect((await replaceDraft(id, 200, '   ', profile)).ok).toBe(false)
    expect((await replaceDraft(id, 200, '가'.repeat(600), profile)).ok).toBe(false)
    const c = await getCampaign(id)
    expect([c.draft_text, c.revision]).toEqual(['초안입니다', 1])
  })
})

describe('markPosted', () => {
  it('moves DRAFT_REVIEW to POSTED at the current revision', async () => {
    const id = await seedDraftCampaign()
    expect(await markPosted(id, 1)).toBe(true)
    const c = await getCampaign(id)
    expect(c.status).toBe('POSTED')
    expect(c.posted_at).not.toBeNull()
    expect(await markPosted(id, 1)).toBe(false)
  })
  it('refuses a stale revision after the draft changed', async () => {
    const id = await seedDraftCampaign()
    await replaceDraft(id, 200, '새 글', profile)
    expect(await markPosted(id, 1)).toBe(false)
    expect((await getCampaign(id)).status).toBe('DRAFT_REVIEW')
  })
})

describe('pending draft requests (draft_seq)', () => {
  it('a request is pending until the draft for that seq is written', async () => {
    const id = await seedCampaign({ memo: '메모' })
    const seq = (await requestDraftRegeneration(id)) ?? 0
    let c = await getCampaign(id)
    expect(c.regen_seq).toBeGreaterThan(c.draft_seq)
    chatJson.mockResolvedValue({ text: '요청에 대한 결과입니다' })
    expect(await generateReviewDraft(id, { seq })).toBe(true)
    c = await getCampaign(id)
    expect(c.draft_seq).toBe(c.regen_seq)
  })
  it('a newer request keeps it pending after an older result is dropped', async () => {
    const id = await seedCampaign({ memo: '메모' })
    const older = (await requestDraftRegeneration(id)) ?? 0
    await requestDraftRegeneration(id)
    chatJson.mockResolvedValue({ text: '오래된 요청의 결과입니다' })
    expect(await generateReviewDraft(id, { seq: older })).toBe(false)
    const c = await getCampaign(id)
    expect(c.regen_seq).toBeGreaterThan(c.draft_seq)
  })
  it('an owner edit leaves nothing pending', async () => {
    const id = await seedDraftCampaign()
    await requestDraftRegeneration(id)
    await replaceDraft(id, 200, '내가 고친 리뷰', profile)
    const c = await getCampaign(id)
    expect(c.draft_seq).toBe(c.regen_seq)
  })
  it('requestDraftRegeneration with a revision refuses a changed draft', async () => {
    const id = await seedDraftCampaign()
    expect(await requestDraftRegeneration(id, 0)).toBeNull()
    expect(await requestDraftRegeneration(id, 1)).not.toBeNull()
  })
})

describe('without a control message (web console)', () => {
  it('replaceDraftGuarded binds to the revision instead of the control message', async () => {
    const id = await seedDraftCampaign()
    const stale = await replaceDraftGuarded(id, { revision: 0 }, '글', profile)
    expect(stale).toMatchObject({ ok: false, stale: true })
    expect((await replaceDraftGuarded(id, { revision: 1 }, '글입니다', profile)).ok).toBe(true)
  })
  it('markPosted with control: false ignores review_revision, but not revision', async () => {
    const id = await seedDraftCampaign({ review_revision: 0 })
    expect(await markPosted(id, 1)).toBe(false)
    expect(await markPosted(id, 0, { control: false })).toBe(false)
    expect(await markPosted(id, 1, { control: false })).toBe(true)
  })
})
