import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../config.ts'

const run = promisify(execFile)

/** Prefix of the stdout line that carries a script's JSON result. */
export const RESULT_MARKER = '__ASIDE_RESULT__'
const DEFAULT_TIMEOUT_MS = 90_000

export type PageSnapshot = { url: string; title: string; text: string }

export type AgentCallOptions = {
  /** Submits, saves or posts something. Skipped (resolves to null) when ASIDE_DRY_RUN=true. */
  sideEffect?: boolean
  timeoutMs?: number
}

/**
 * The Aside browser on the local PC, logged in to revu and Naver as the owner. Like ThreadsApi,
 * everything that drives the browser goes through this interface so tests use a fake.
 *
 * Unverified until the Phase 0 spike: what `openTab` returns. Scripts assume a Playwright-like
 * page (`evaluate`, `title`, `url`, `fill`, `click`, `setInputFiles`, `screenshot`).
 */
export interface BrowserAgent {
  readonly dryRun: boolean
  /** Opens `url` in the logged-in browser and returns its visible text. Never a side effect. */
  readPage(url: string, opts?: { timeoutMs?: number }): Promise<PageSnapshot>
  /**
   * Runs `body` with `aside repl` as the body of an async function and returns its JSON-encoded
   * return value. `openTab` is in scope.
   */
  runScript<T>(body: string, opts?: AgentCallOptions): Promise<T | null>
  /** Runs a natural-language agent task (`aside "<task>"`) and returns its final output. */
  runTask(task: string, opts?: AgentCallOptions): Promise<string | null>
}

/** Wraps a script body so its return value is printed as one marker line. */
export function wrapScript(body: string): string {
  return `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(await (async () => {\n${body}\n})()))`
}

/** Finds the marker line in `aside repl` output; the last one wins. */
export function parseScriptOutput<T>(stdout: string): T {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(RESULT_MARKER))
  if (line === undefined) {
    throw new Error(`aside repl printed no result: ${stdout.slice(0, 300)}`)
  }
  const json = line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length)
  return (json === '' || json === 'undefined' ? null : JSON.parse(json)) as T
}

export const READ_PAGE_SCRIPT = (url: string) => `
const p = await openTab(${JSON.stringify(url)})
if (p.waitForLoadState) await p.waitForLoadState('networkidle').catch(() => {})
return {
  url: typeof p.url === 'function' ? p.url() : String(p.url ?? ${JSON.stringify(url)}),
  title: typeof p.title === 'function' ? await p.title() : '',
  text: await p.evaluate(() => document.body.innerText),
}`

export class AsideCliAgent implements BrowserAgent {
  constructor(
    readonly dryRun = config.ASIDE_DRY_RUN,
    private readonly bin = config.ASIDE_BIN,
    private readonly account = config.ASIDE_ACCOUNT,
  ) {}

  private accountArgs(): string[] {
    return this.account ? ['--account', this.account] : []
  }

  private async exec(args: string[], timeoutMs: number): Promise<string> {
    try {
      const { stdout } = await run(this.bin, args, {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      })
      return stdout
    } catch (err) {
      const e = err as Error & { stderr?: string; killed?: boolean }
      const detail = e.stderr?.trim().slice(0, 500) || e.message
      throw new Error(`aside ${args[0] ?? ''} failed${e.killed ? ' (timeout)' : ''}: ${detail}`)
    }
  }

  async readPage(url: string, opts: { timeoutMs?: number } = {}): Promise<PageSnapshot> {
    const page = await this.runScript<PageSnapshot>(READ_PAGE_SCRIPT(url), opts)
    if (!page || typeof page.text !== 'string') throw new Error(`aside read ${url}: no page text`)
    return page
  }

  async runScript<T>(body: string, opts: AgentCallOptions = {}): Promise<T | null> {
    if (opts.sideEffect && this.dryRun) {
      console.log(`[aside dry-run] script skipped:\n${body}`)
      return null
    }
    const stdout = await this.exec(
      ['repl', ...this.accountArgs(), wrapScript(body)],
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    return parseScriptOutput<T>(stdout)
  }

  async runTask(task: string, opts: AgentCallOptions = {}): Promise<string | null> {
    if (opts.sideEffect && this.dryRun) {
      console.log(`[aside dry-run] task skipped: ${task}`)
      return null
    }
    const stdout = await this.exec(
      [...this.accountArgs(), task],
      opts.timeoutMs ?? 10 * DEFAULT_TIMEOUT_MS,
    )
    return stdout.trim()
  }
}

let agent: BrowserAgent | undefined

export function getBrowserAgent(): BrowserAgent {
  agent ??= new AsideCliAgent()
  return agent
}

/** For tests and the CLI: replaces the process-wide agent. */
export function setBrowserAgent(next: BrowserAgent | undefined): void {
  agent = next
}
