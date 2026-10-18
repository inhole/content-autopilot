import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { loadUnsentReviews, UNSENT_REVIEW_MINUTES } from '../../src/pipeline/maintenance.ts'
import { seedPost, seedTopic } from './helpers.ts'

const NOW = new Date('2026-10-19T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

async function seed(opts: { status?: string; messageId?: number | null; touched: Date }) {
  const id = await seedPost(await seedTopic(), { status: opts.status ?? 'PENDING_REVIEW' })
  await query('update posts set review_message_id = $2, updated_at = $3 where id = $1', [
    id,
    opts.messageId ?? null,
    opts.touched,
  ])
  return id
}

describe('loadUnsentReviews', () => {
  it('finds drafts left without a review message, not fresh, sent or finished ones', async () => {
    const lost = await seed({ touched: minutesAgo(UNSENT_REVIEW_MINUTES + 1) })
    await seed({ touched: minutesAgo(UNSENT_REVIEW_MINUTES - 1) }) // its review job may still run
    await seed({ messageId: 77, touched: minutesAgo(120) }) // already sent
    await seed({ status: 'EXPIRED', touched: minutesAgo(120) })
    await seed({ status: 'SCHEDULED', touched: minutesAgo(120) })

    expect(await loadUnsentReviews(NOW)).toEqual([lost])
  })
})
