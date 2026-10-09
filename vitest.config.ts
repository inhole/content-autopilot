import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees and contain full copies of the tests.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
