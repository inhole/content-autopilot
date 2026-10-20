import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type BrowserAgent, getBrowserAgent, type ScriptArgs } from './client.ts'

/** aside/scripts at the repo root: one `aside repl` script body per file (docs/aside.md). */
export const SCRIPTS_DIR = fileURLToPath(new URL('../../aside/scripts/', import.meta.url))

const NAME = /^[a-z0-9][a-z0-9-]*$/

export type ScriptArg = { name: string; optional: boolean }
export type ScriptHeader = { description: string; args: ScriptArg[] }

/**
 * Reads the leading `//` comment of a script: `// args: url, interactive?` declares its arguments
 * (`?` = optional), every other line is the description.
 */
export function parseHeader(source: string): ScriptHeader {
  const description: string[] = []
  const args: ScriptArg[] = []
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('//')) break
    const text = line.slice(2).trim()
    const decl = /^args:\s*(.*)$/.exec(text)
    if (!decl) {
      description.push(text)
      continue
    }
    for (const part of (decl[1] ?? '').split(',')) {
      const name = part.trim()
      if (!name) continue
      const optional = name.endsWith('?')
      args.push({ name: optional ? name.slice(0, -1) : name, optional })
    }
  }
  return { description: description.join(' ').trim(), args }
}

/** `key=value` CLI words into script args; the value may itself contain `=`. */
export function parseArgs(words: string[]): ScriptArgs {
  const args: ScriptArgs = {}
  for (const word of words) {
    const eq = word.indexOf('=')
    if (eq <= 0) throw new Error(`expected key=value, got "${word}"`)
    args[word.slice(0, eq)] = word.slice(eq + 1)
  }
  return args
}

/** Rejects missing required and undeclared args, so a typo never runs a script half-configured. */
export function checkArgs(header: ScriptHeader, args: ScriptArgs): void {
  const declared = new Set(header.args.map((a) => a.name))
  const unknown = Object.keys(args).filter((k) => !declared.has(k))
  if (unknown.length > 0) throw new Error(`unknown arg(s): ${unknown.join(', ')}`)
  const missing = header.args.filter((a) => !a.optional && !(a.name in args)).map((a) => a.name)
  if (missing.length > 0) throw new Error(`missing arg(s): ${missing.join(', ')}`)
}

export async function loadScript(
  name: string,
  dir = SCRIPTS_DIR,
): Promise<{ body: string; header: ScriptHeader }> {
  // The name becomes a path, so only plain names are accepted.
  if (!NAME.test(name)) throw new Error(`invalid script name: ${name}`)
  let body: string
  try {
    body = await readFile(`${dir}/${name}.js`, 'utf8')
  } catch {
    throw new Error(`no such aside script: ${name} (see aside:list)`)
  }
  return { body, header: parseHeader(body) }
}

export async function listScripts(
  dir = SCRIPTS_DIR,
): Promise<Array<{ name: string } & ScriptHeader>> {
  const names = (await readdir(dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .filter((n) => NAME.test(n))
    .sort()
  return Promise.all(names.map(async (name) => ({ name, ...(await loadScript(name, dir)).header })))
}

export async function runAsideScript<T = unknown>(
  name: string,
  args: ScriptArgs,
  opts: { agent?: BrowserAgent; dir?: string } = {},
): Promise<T> {
  const { body, header } = await loadScript(name, opts.dir)
  checkArgs(header, args)
  return (opts.agent ?? getBrowserAgent()).runScript<T>(body, { args })
}
