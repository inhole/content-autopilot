// npm "prepare": point git at .githooks. No-op outside a git checkout (e.g. Railway builds).
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
} catch {
  // Not a git repository or git is unavailable.
}
