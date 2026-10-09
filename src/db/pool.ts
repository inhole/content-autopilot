import pg from 'pg'
import { config } from '../config.ts'

// bigserial ids and numeric scores stay well within Number range here.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // Supabase pooler presents a certificate chain Node does not trust by default.
  ssl: { rejectUnauthorized: false },
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
