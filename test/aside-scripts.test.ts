import { describe, expect, it } from 'vitest'
import type { BrowserAgent } from '../src/aside/client.ts'
import {
  checkArgs,
  listScripts,
  loadScript,
  parseArgs,
  parseHeader,
  runAsideScript,
} from '../src/aside/scripts.ts'

describe('parseHeader', () => {
  it('reads the description and arg declarations up to the first code line', () => {
    const h = parseHeader(
      '// Open a page.\n// Then close it.\n// args: url, interactive?\nconst x = 1\n// later',
    )
    expect(h.description).toBe('Open a page. Then close it.')
    expect(h.args).toEqual([
      { name: 'url', optional: false },
      { name: 'interactive', optional: true },
    ])
  })

  it('handles a script without a header', () => {
    expect(parseHeader('return 1')).toEqual({ description: '', args: [] })
  })
})

describe('parseArgs / checkArgs', () => {
  const header = parseHeader('// x\n// args: url, interactive?')

  it('splits on the first = only', () => {
    expect(parseArgs(['url=https://a.kr/?q=1&b=2'])).toEqual({ url: 'https://a.kr/?q=1&b=2' })
    expect(() => parseArgs(['url'])).toThrow('key=value')
    expect(() => parseArgs(['=x'])).toThrow('key=value')
  })

  it('rejects missing required and unknown args', () => {
    expect(() => checkArgs(header, {})).toThrow('missing arg(s): url')
    expect(() => checkArgs(header, { url: 'u', urll: 'u' })).toThrow('unknown arg(s): urll')
    expect(() => checkArgs(header, { url: 'u' })).not.toThrow()
  })
})

describe('script files', () => {
  it('lists the bundled scripts with their headers', async () => {
    const scripts = await listScripts()
    expect(scripts.map((s) => s.name)).toEqual(
      expect.arrayContaining(['fetch', 'links', 'snapshot', 'tabs']),
    )
    for (const s of scripts) expect(s.description).not.toBe('')
  })

  it('refuses names that could escape the scripts folder', async () => {
    await expect(loadScript('../src/cli')).rejects.toThrow('invalid script name')
    await expect(loadScript('nope-not-here')).rejects.toThrow('no such aside script')
  })

  it('runs a script through the agent with its args', async () => {
    const calls: Array<{ body: string; args: unknown }> = []
    const agent: BrowserAgent = {
      runScript: async <T>(body: string, opts?: { args?: Record<string, string> }) => {
        calls.push({ body, args: opts?.args })
        return 'ok' as T
      },
    }
    await expect(runAsideScript('snapshot', { url: 'https://a.kr' }, { agent })).resolves.toBe('ok')
    expect(calls[0]?.args).toEqual({ url: 'https://a.kr' })
    expect(calls[0]?.body).toContain('openTab(args.url)')
    await expect(runAsideScript('snapshot', {}, { agent })).rejects.toThrow('missing arg(s): url')
    expect(calls).toHaveLength(1)
  })
})
