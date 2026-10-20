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
