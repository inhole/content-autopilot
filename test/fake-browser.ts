import type { BrowserAgent } from '../src/aside/client.ts'

/** A BrowserAgent that records scripts and answers with canned results (or throws). */
export class FakeBrowser implements BrowserAgent {
  scripts: string[] = []
  constructor(private readonly respond: (body: string) => unknown | Promise<unknown>) {}

  async runScript<T>(body: string): Promise<T> {
    this.scripts.push(body)
    return (await this.respond(body)) as T
  }
}
