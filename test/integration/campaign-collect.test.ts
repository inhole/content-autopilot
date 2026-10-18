import { describe, expect, it } from 'vitest'
import { addCampaignUrl, collectFromKakao } from '../../src/campaigns/collect.ts'
import { query } from '../../src/db/pool.ts'

const transcript = (...bodies: string[]) =>
  bodies.map((b, i) => `[봇] [오후 1:${String(i).padStart(2, '0')}] ${b}`).join('\n')

const counts = async () => {
  const [c] = await query<{ n: number }>('select count(*)::int as n from campaigns')
  const [k] = await query<{ n: number }>('select count(*)::int as n from kakao_messages')
  return { campaigns: c?.n, messages: k?.n }
}

describe('addCampaignUrl', () => {
  it('creates once and returns the existing id afterwards', async () => {
    const first = await addCampaignUrl('https://www.revu.net/campaign/77?x=1', 'room')
    expect(first?.created).toBe(true)
    const again = await addCampaignUrl('revu.net/campaign/77')
    expect(again).toEqual({ id: first?.id, created: false })

    const [row] = await query<{ status: string; found_in: string; url: string }>(
      'select status, found_in, url from campaigns',
    )
    expect(row).toEqual({
      status: 'DISCOVERED',
      found_in: 'room',
      url: 'https://www.revu.net/campaign/77',
    })
  })

  it('returns null for non-campaign links', async () => {
    expect(await addCampaignUrl('https://example.com/campaign/1')).toBeNull()
    expect(await counts()).toEqual({ campaigns: 0, messages: 0 })
  })
})

describe('collectFromKakao', () => {
  it('handles new messages once and ignores a re-read', async () => {
    const text = transcript('링크 revu.net/campaign/1', '잡담', 'https://www.revu.net/campaign/2')
    const read = async () => text

    const [first] = await collectFromKakao({ rooms: ['A'], read })
    expect(first?.newMessages).toBe(3)
    expect(first?.newCampaignIds).toHaveLength(2)

    const [second] = await collectFromKakao({ rooms: ['A'], read })
    expect(second).toEqual({ room: 'A', newMessages: 0, newCampaignIds: [] })
    expect(await counts()).toEqual({ campaigns: 2, messages: 3 })

    // Only the appended message is new on the next read.
    const [third] = await collectFromKakao({
      rooms: ['A'],
      read: async () => `${text}\n[봇] [오후 2:00] revu.net/campaign/3`,
    })
    expect(third?.newMessages).toBe(1)
    expect(third?.newCampaignIds).toHaveLength(1)
  })

  it('isolates a failing room', async () => {
    const results = await collectFromKakao({
      rooms: ['bad', 'good'],
      read: async (room) => {
        if (room === 'bad') throw new Error('window not found')
        return transcript('revu.net/campaign/5')
      },
    })
    expect(results[0]).toMatchObject({ room: 'bad', newMessages: 0, error: 'window not found' })
    expect(results[1]?.newCampaignIds).toHaveLength(1)
    expect(results[1]?.error).toBeUndefined()
  })

  it('creates one campaign for the same link in two rooms', async () => {
    const read = async () => transcript('revu.net/campaign/9')
    const [a, b] = await collectFromKakao({ rooms: ['A', 'B'], read })
    expect(a?.newCampaignIds).toHaveLength(1)
    expect(b?.newMessages).toBe(1)
    expect(b?.newCampaignIds).toEqual([])
    const rows = await query<{ found_in: string }>('select found_in from campaigns')
    expect(rows).toEqual([{ found_in: 'A' }])
  })

  it('keeps repeated identical messages distinct', async () => {
    const text = '[봇] [오후 1:00] 같은 말\n[봇] [오후 1:00] 같은 말'
    const [r] = await collectFromKakao({ rooms: ['A'], read: async () => text })
    expect(r?.newMessages).toBe(2)
  })
})
