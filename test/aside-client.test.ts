import { describe, expect, it } from 'vitest'
import {
  AsideCliAgent,
  AsideNotRunningError,
  parseScriptOutput,
  RESULT_MARKER,
  resolveAsideBin,
  wrapScript,
} from '../src/aside/client.ts'

describe('wrapScript / parseScriptOutput', () => {
  it('round-trips through a real evaluation of the wrapped script', async () => {
    const wrapped = wrapScript('return { a: [1, "x\\"y"], b: null }')
    const lines: string[] = []
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    await new AsyncFunction('console', wrapped)({ log: (s: string) => lines.push(s) })
    expect(parseScriptOutput(lines.join('\n'))).toEqual({ a: [1, 'x"y'], b: null })
  })

  it('ignores status noise and takes the last marker line', () => {
    const out = `\u001b[2m[ok | 60ms]\u001b[0m\n${RESULT_MARKER}{"n":1}\nnoise\n${RESULT_MARKER}{"n":2}\n`
    expect(parseScriptOutput(out)).toEqual({ n: 2 })
  })

  it('maps an undefined return to null and fails without a marker', () => {
    expect(parseScriptOutput(`${RESULT_MARKER}undefined`)).toBeNull()
    expect(() => parseScriptOutput('nothing here')).toThrow('printed no result')
  })

  it('keeps hostile text inside the JSON string literal', () => {
    const body = `return ${JSON.stringify('"); process.exit(1); //')}`
    expect(wrapScript(body)).toContain(RESULT_MARKER)
  })
})

describe('resolveAsideBin', () => {
  it('prefers ASIDE_BIN, then the installed exe, then PATH', () => {
    expect(resolveAsideBin({ ASIDE_BIN: 'x.exe', LOCALAPPDATA: 'C:\\L' }, () => true)).toBe('x.exe')
    expect(resolveAsideBin({ LOCALAPPDATA: 'C:\\L' }, () => true)).toMatch(/aside\.exe$/)
    expect(resolveAsideBin({ LOCALAPPDATA: 'C:\\L' }, () => false)).toBe('aside')
    expect(resolveAsideBin({}, () => true)).toBe('aside')
  })
})

describe('AsideCliAgent', () => {
  it('reports a missing CLI as not running', async () => {
    const agent = new AsideCliAgent('definitely-not-a-real-aside-binary', undefined)
    await expect(agent.runScript('return 1')).rejects.toBeInstanceOf(AsideNotRunningError)
  })

  it('turns a failing CLI without a marker into a plain error', async () => {
    // node cannot run `repl ...`: exits non-zero, which is not "Aside isn't running".
    const agent = new AsideCliAgent(process.execPath, undefined)
    const err = await agent.runScript('return 1').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AsideNotRunningError)
  })
})
