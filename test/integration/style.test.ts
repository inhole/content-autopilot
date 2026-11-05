import { describe, expect, it } from 'vitest'
import { query } from '../../src/db/pool.ts'
import { loadStyleContext } from '../../src/pipeline/style.ts'
import { seedPost, seedTopic } from './helpers.ts'

async function published(text: string, generation: unknown) {
  const id = await seedPost(await seedTopic({ url: null }), { status: 'PUBLISHED', text })
  await query('update posts set generation = $2::jsonb where id = $1', [
    id,
    JSON.stringify(generation),
  ])
  return id
}

describe('loadStyleContext examples', () => {
  it('uses only posts written under prompt_version >= 2', async () => {
    await published('옛날 음슴체 글임', { text: '옛날 음슴체 글임' })
    await published('버전 1 글임', { text: '버전 1 글임', prompt_version: 1 })
    await published('깨진 버전 글', { text: '깨진 버전 글', prompt_version: 'x' })
    await published('새 반말 글이야', { text: '새 반말 글이야', prompt_version: 2 })
    await published('직접 고친 글이야', { text: '원래 글', prompt_version: 2 })
    const ctx = await loadStyleContext()
    expect(ctx.examples.map((e) => e.text).sort()).toEqual(['새 반말 글이야', '직접 고친 글이야'])
    // Edited posts come first.
    expect(ctx.examples[0]).toMatchObject({ text: '직접 고친 글이야', edited: true })
    // Recent lines are not filtered by version.
    expect(ctx.recentFirstLines).toContain('옛날 음슴체 글임')
  })

  it('has no examples when no post carries a version', async () => {
    await published('옛날 글임', { text: '옛날 글임' })
    expect((await loadStyleContext()).examples).toEqual([])
  })
})

describe('loadStyleContext top first lines', () => {
  async function measured(
    text: string,
    views: number,
    opts: { chain?: boolean; origin?: string } = {},
  ) {
    const id = await published(text, { text, prompt_version: 2 })
    await query(
      `update posts set origin = $2, platform_post_id = 'media-' || id,
         published_at = now() - interval '3 days' where id = $1`,
      [id, opts.origin ?? 'news'],
    )
    if (opts.chain) {
      await query(
        "insert into post_parts (post_id, idx, text, status) values ($1, 2, 'p', 'PUBLISHED')",
        [id],
      )
    }
    await query(
      `insert into post_insights (post_id, collected_at, views)
       select id, published_at + interval '2 days', $2 from posts where id = $1`,
      [id, views],
    )
  }

  it('learns from the best posts of the same format only', async () => {
    for (const [i, v] of [1, 2, 3, 40, 50, 60].entries()) await measured(`단독 ${i}`, v)
    for (const [i, v] of [9, 8, 7, 6, 5].entries()) await measured(`연결 ${i}`, v, { chain: true })
    await measured('묶음 글', 9999, { origin: 'digest' })

    expect((await loadStyleContext({ chain: false })).topFirstLines).toEqual([
      '단독 5',
      '단독 4',
      '단독 3',
    ])
    // Five measured chain posts are not enough to learn from.
    expect((await loadStyleContext({ chain: true })).topFirstLines).toEqual([])
  })

  it('learns chain posts from chain posts once six are measured', async () => {
    for (const [i, v] of [1, 2, 3, 4, 5].entries()) await measured(`단독 ${i}`, v * 100)
    for (const [i, v] of [9, 8, 7, 6, 5, 4].entries()) {
      await measured(`연결 ${i}`, v, { chain: true })
    }
    expect((await loadStyleContext({ chain: true })).topFirstLines).toEqual([
      '연결 0',
      '연결 1',
      '연결 2',
    ])
  })
})
