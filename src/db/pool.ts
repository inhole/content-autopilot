import pg from 'pg'
import { config } from '../config.ts'

// bigserial ids and numeric scores stay well within Number range here.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)

// Supabase pooler presents a certificate chain Node does not trust by default.
// Shared with pg-boss, which opens its own pool. DATABASE_SSL=false is for local/CI Postgres.
export const dbSsl = config.DATABASE_SSL ? { rejectUnauthorized: false } : false

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: dbSsl,
  max: 5,
})

// An unhandled 'error' on an idle client (DB restart, pooler dropping connections) would crash the worker.
pool.on('error', (err) => {
  console.error('pg pool idle client error:', err)
})

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, values)
  return result.rows
}

/** `query` bound to one client, for statements that must share a transaction. */
export type Query = <T extends pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<T[]>

/** Runs `fn` in a transaction on one pooled client; rolls back if it throws. */
export async function transaction<R>(fn: (q: Query) => Promise<R>): Promise<R> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const q: Query = async (text, values) => (await client.query(text, values)).rows
    const result = await fn(q)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
