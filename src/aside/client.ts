import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from '../config.ts'

const run = promisify(execFile)

/** Prefix of the stdout line that carries a script's JSON result. */
export const RESULT_MARKER = '__ASIDE_RESULT__'
const DEFAULT_TIMEOUT_MS = 110_000

/** The Aside desktop app is not running (or its CLI cannot reach it). */
export class AsideNotRunningError extends Error {
  constructor(detail = '') {
    super(`Aside is not running on this machine${detail ? `: ${detail}` : ''}`)
    this.name = 'AsideNotRunningError'
  }
}

export type ScriptArgs = Record<string, string>

/**
 * The Aside browser on the owner's PC, logged in as the owner. Everything that drives the browser
 * goes through this interface so tests can use a fake.
 */
export interface BrowserAgent {
  /**
   * Runs `body` with `aside repl` as the body of an async function and returns its JSON-encoded
   * return value. `args` is in scope, as are the REPL globals (`openTab`, `fetch`, `snapshot`, ...).
   */
  runScript<T>(body: string, opts?: { timeoutMs?: number; args?: ScriptArgs }): Promise<T>
}

/**
 * Wraps a script body so its return value is printed as one marker line. The body runs inside a
 * function, so its bindings never collide with ones left in the persistent REPL context.
 */
export function wrapScript(body: string, args: ScriptArgs = {}): string {
  return `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(await (async (args) => {\n${body}\n})(${JSON.stringify(args)})))`
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
  const json = line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim()
  return (json === '' || json === 'undefined' ? null : JSON.parse(json)) as T
}

/** ASIDE_BIN, else the default Windows install when present, else `aside` from PATH. */
export function resolveAsideBin(
  env: { ASIDE_BIN?: string; LOCALAPPDATA?: string } = {
    ASIDE_BIN: config.ASIDE_BIN,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  },
  exists: (p: string) => boolean = existsSync,
): string {
  if (env.ASIDE_BIN) return env.ASIDE_BIN
  if (env.LOCALAPPDATA) {
    const installed = join(env.LOCALAPPDATA, 'Aside', 'CLI', 'current', 'aside.exe')
    if (exists(installed)) return installed
  }
  return 'aside'
}

const NOT_RUNNING = /isn'?t running|not running/i

export class AsideCliAgent implements BrowserAgent {
  constructor(
    private readonly bin = resolveAsideBin(),
    private readonly account = config.ASIDE_ACCOUNT,
  ) {}

  async runScript<T>(
    body: string,
    opts: { timeoutMs?: number; args?: ScriptArgs } = {},
  ): Promise<T> {
    const args = [
      'repl',
      ...(this.account ? ['--account', this.account] : []),
      wrapScript(body, opts.args),
    ]
    let stdout: string
    try {
      ;({ stdout } = await run(this.bin, args, {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      }))
    } catch (err) {
      const e = err as Error & {
        stderr?: string
        stdout?: string
        killed?: boolean
        code?: unknown
      }
      const text = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()
      if (e.code === 'ENOENT') throw new AsideNotRunningError(`CLI not found (${this.bin})`)
      if (NOT_RUNNING.test(text)) throw new AsideNotRunningError()
      throw new Error(
        `aside repl failed${e.killed ? ' (timeout)' : ''}: ${text.slice(0, 500) || e.message}`,
      )
    }
    if (NOT_RUNNING.test(stdout) && !stdout.includes(RESULT_MARKER))
      throw new AsideNotRunningError()
    return parseScriptOutput<T>(stdout)
  }
}

let agent: BrowserAgent | undefined

export function getBrowserAgent(): BrowserAgent {
  agent ??= new AsideCliAgent()
  return agent
}

/** For tests: replaces the process-wide agent. */
export function setBrowserAgent(next: BrowserAgent | undefined): void {
  agent = next
}
