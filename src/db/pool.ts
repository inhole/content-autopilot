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
