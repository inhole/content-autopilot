import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pool } from './pool.ts'

const dir = join(import.meta.dirname, '..', '..', 'migrations')

export async function migrate(): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    )
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (r) => r.name,
      ),
    )
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (err) {
        await client.query('rollback')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    client.release()
  }
  return applied
}

if (import.meta.main) {
  const applied = await migrate()
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date')
  await pool.end()
}
