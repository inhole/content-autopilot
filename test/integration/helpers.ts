import { query } from '../../src/db/pool.ts'

export async function seedTopic(
  opts: { title?: string; url?: string | null; status?: string } = {},
): Promise<number> {
  const [row] = await query<{ id: number }>(
    'insert into topics (title, url, status) values ($1, $2, $3) returning id',
    [
      opts.title ?? 'topic',
      opts.url === undefined ? 'https://example.com/a' : opts.url,
      opts.status ?? 'SHORTLISTED',
    ],
  )
  if (!row) throw new Error('seedTopic failed')
  return row.id
}

export async function seedPost(
  topicId: number,
  opts: { status?: string; scheduledAt?: Date | null; text?: string } = {},
): Promise<number> {
  const [row] = await query<{ id: number }>(
    'insert into posts (topic_id, text, status, scheduled_at) values ($1, $2, $3, $4) returning id',
    [topicId, opts.text ?? 'hello', opts.status ?? 'PENDING_REVIEW', opts.scheduledAt ?? null],
  )
  if (!row) throw new Error('seedPost failed')
  return row.id
}

export async function getPost(id: number) {
  const [row] = await query<{
    status: string
    scheduled_at: Date | null
    container_id: string | null
    claim_seq: number
    attempts: number
    revision: number
    regen_seq: number
  }>(
    'select status, scheduled_at, container_id, claim_seq, attempts, revision, regen_seq from posts where id = $1',
    [id],
  )
  if (!row) throw new Error(`post ${id} not found`)
  return row
}
