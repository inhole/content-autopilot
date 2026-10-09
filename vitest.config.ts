import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees and contain full copies of the tests.
    // Integration tests need a real Postgres and run via `npm run test:integration`.
    exclude: [...configDefaults.exclude, '.claude/**', 'test/integration/**'],
  },
})
