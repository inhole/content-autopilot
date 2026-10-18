import type { AgentCallOptions, BrowserAgent, PageSnapshot } from '../src/aside/client.ts'

/** Records calls and answers from queues of canned results, in call order. */
export class FakeBrowserAgent implements BrowserAgent {
  readonly calls: { kind: 'read' | 'script' | 'task'; input: string; opts?: AgentCallOptions }[] =
    []
  pages = new Map<string, PageSnapshot | Error>()
  scriptResults: unknown[] = []
  taskResults: (string | Error)[] = []

  constructor(readonly dryRun = false) {}

  async readPage(url: string): Promise<PageSnapshot> {
    this.calls.push({ kind: 'read', input: url })
    const page = this.pages.get(url)
    if (page instanceof Error) throw page
    if (!page) throw new Error(`fake: no page for ${url}`)
    return page
  }

  async runScript<T>(body: string, opts?: AgentCallOptions): Promise<T | null> {
    this.calls.push({ kind: 'script', input: body, opts })
    if (opts?.sideEffect && this.dryRun) return null
    const next = this.scriptResults.shift()
    if (next instanceof Error) throw next
    return (next ?? null) as T | null
  }

  async runTask(task: string, opts?: AgentCallOptions): Promise<string | null> {
    this.calls.push({ kind: 'task', input: task, opts })
    if (opts?.sideEffect && this.dryRun) return null
    const next = this.taskResults.shift()
    if (next instanceof Error) throw next
    return next ?? ''
  }
}
