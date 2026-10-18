import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBrowserAgent } from './fake-browser.ts'

const chatJson = vi.fn()
vi.mock('../src/llm/openrouter.ts', () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }))

const query = vi.fn()
vi.mock('../src/db/pool.ts', () => ({ query: (...args: unknown[]) => query(...args) }))

const { TransientCampaignError, detailToColumns, fetchCampaignDetail, unreadableReason } =
  await import('../src/campaigns/revu.ts')

import type { CampaignDetail } from '../src/campaigns/types.ts'

const detail = (over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  title: '무선 이어폰',
  type: 'delivery',
  category: 'IT',
  offer: '무선 이어폰 1개',
  rewardWon: 59000,
  recruitCount: 5,
  applyDeadline: '2026-10-25T23:59:00+09:00',
  announceAt: '2026-10-27T00:00:00+09:00',
  reviewDeadline: 'not a date',
  channel: '네이버 블로그',
  keywords: ['이어폰'],
  guide: '사진 5장',
  applyQuestions: [],
  ...over,
})

describe('detailToColumns', () => {
  it('converts ISO strings to dates and invalid ones to null', () => {
    const col = detailToColumns(detail())
    expect(col.apply_deadline?.toISOString()).toBe('2026-10-25T14:59:00.000Z')
    expect(col.announce_at?.toISOString()).toBe('2026-10-26T15:00:00.000Z')
    expect(col.review_deadline).toBeNull()
    expect(col.reward_won).toBe(59000)
    expect(col.keywords).toEqual(['이어폰'])
  })

  it('keeps null dates null', () => {
    const col = detailToColumns(detail({ applyDeadline: null, announceAt: null }))
    expect(col.apply_deadline).toBeNull()
    expect(col.announce_at).toBeNull()
  })
})

describe('unreadableReason', () => {
  it('flags short text, login walls and not-found pages', () => {
    expect(unreadableReason('짧음')).toMatch(/too short/)
    expect(unreadableReason(`로그인이 필요합니다. ${'가'.repeat(250)}`)).toBe('login wall')
    expect(unreadableReason(`요청하신 페이지를 찾을 수 없습니다. ${'가'.repeat(250)}`)).toBe(
      'campaign not found',
    )
  })
  it('accepts a long campaign page that mentions login in the header', () => {
    expect(unreadableReason(`로그인 모집 인원 5명 ${'가'.repeat(900)}`)).toBeNull()
  })
})

describe('fetchCampaignDetail', () => {
  const URL = 'https://www.revu.net/campaign/123'
  const row = (status = 'DISCOVERED') => ({ id: 1, url: URL, status })
  let agent: FakeBrowserAgent

  beforeEach(() => {
    chatJson.mockReset()
    query.mockReset()
    agent = new FakeBrowserAgent()
  })

  it('ignores a campaign that is not DISCOVERED', async () => {
    query.mockResolvedValueOnce([row('DETAILED')])
    expect(await fetchCampaignDetail(1, agent)).toBe('not-pending')
    expect(agent.calls).toHaveLength(0)
  })

  it('marks a login wall UNREADABLE without calling the LLM', async () => {
    query.mockResolvedValueOnce([row()]).mockResolvedValueOnce([])
    agent.pages.set(URL, { url: URL, title: '', text: '로그인 후 이용해주세요' })
    expect(await fetchCampaignDetail(1, agent)).toBe('unreadable')
    expect(chatJson).not.toHaveBeenCalled()
    const update = query.mock.calls[1] as [string, unknown[]]
    expect(update[0]).toContain("status = 'UNREADABLE'")
    expect(update[1][0]).toBe(1)
  })

  it('throws a transient error when the browser fails', async () => {
    query.mockResolvedValueOnce([row()])
    agent.pages.set(URL, new Error('aside repl failed (timeout)'))
    await expect(fetchCampaignDetail(1, agent)).rejects.toBeInstanceOf(TransientCampaignError)
    expect(query).toHaveBeenCalledOnce()
  })

  it('throws a transient error when the LLM output is invalid', async () => {
    query.mockResolvedValueOnce([row()])
    agent.pages.set(URL, { url: URL, title: '', text: '가'.repeat(1000) })
    chatJson.mockRejectedValueOnce(new Error('bad json'))
    await expect(fetchCampaignDetail(1, agent)).rejects.toBeInstanceOf(TransientCampaignError)
  })

  it('stores the extracted detail as DETAILED', async () => {
    query.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ id: 1 }])
    agent.pages.set(URL, { url: URL, title: '', text: `모집 ${'가'.repeat(3000)}` })
    chatJson.mockResolvedValueOnce(detail())
    expect(await fetchCampaignDetail(1, agent)).toBe('detailed')
    const call = chatJson.mock.calls[0]?.[0] as { temperature: number; user: string }
    expect(call.temperature).toBe(0)
    expect(call.user).toContain('오늘 날짜(KST)')
    const update = query.mock.calls[1] as [string, unknown[]]
    expect(update[0]).toContain("status = 'DETAILED'")
    expect(update[1][1]).toBe('무선 이어폰')
  })

  it('truncates very long pages before the LLM call', async () => {
    query.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ id: 1 }])
    agent.pages.set(URL, { url: URL, title: '', text: '가'.repeat(50_000) })
    chatJson.mockResolvedValueOnce(detail())
    await fetchCampaignDetail(1, agent)
    const call = chatJson.mock.calls[0]?.[0] as { user: string }
    expect(call.user.length).toBeLessThan(16_500)
  })
})
