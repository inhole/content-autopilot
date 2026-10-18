import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees and contain full copies of the tests.
    // Integration tests need a real Postgres and run via `npm run test:integration`.
    // The React app in web/ has its own vitest config (jsdom, `@/` alias): `npm run test:web`.
    exclude: [...configDefaults.exclude, '.claude/**', 'test/integration/**', 'web/**'],
  },
})
