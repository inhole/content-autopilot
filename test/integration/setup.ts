import { afterAll, beforeAll, beforeEach } from 'vitest'

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'])

// Integration tests truncate tables, so they must never be pointed at a real database.
// This runs before any test file imports src/db/pool.ts.
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required for integration tests')
let host: string
try {
  host = new URL(url).hostname
} catch {
  throw new Error('DATABASE_URL is not a valid URL')
}
if (!SAFE_HOSTS.has(host)) {
  throw new Error(
    `Refusing to run integration tests against host "${host}"; use localhost, 127.0.0.1 or postgres`,
  )
}

beforeAll(async () => {
  const { migrate } = await import('../../src/db/migrate.ts')
  await migrate()
})

beforeEach(async () => {
  const { pool } = await import('../../src/db/pool.ts')
  await pool.query('truncate posts, topics, platform_accounts restart identity cascade')
})

afterAll(async () => {
  const { pool } = await import('../../src/db/pool.ts')
  await pool.end()
})
