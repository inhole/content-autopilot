import type { Readable } from 'node:stream'
import type { FileActionOutcome, VideoActionOutcome, VideoActions } from '../src/video/actions.ts'

/**
 * In-memory VideoActions for server tests: every call is recorded, `next` scripts the outcome of
 * the following action (default: applied, Telegram synced), `nextFile` that of the file step
 * (default: stored). The file step reads the whole body and records its size.
 */
export function fakeVideoActions() {
  const state = {
    calls: [] as { name: string; id?: number; params?: unknown }[],
    next: undefined as VideoActionOutcome | undefined,
    nextFile: undefined as FileActionOutcome | Error | undefined,
    received: [] as number[],
  }
  const run =
    (name: string) =>
    async (id: number, params?: unknown): Promise<VideoActionOutcome> => {
      state.calls.push({ name, id, params })
      const out = state.next ?? { ok: true, telegramSynced: true }
      state.next = undefined
      return out
    }
  const actions: VideoActions = {
    create: async (p) => {
      state.calls.push({ name: 'create', params: p })
      return { ok: true, id: 41, revision: 1 }
    },
    receiveFile: async (id: number, body: Readable, p) => {
      state.calls.push({ name: 'receiveFile', id, params: p })
      const out = state.nextFile ?? { kind: 'stored', approval: null, telegramSynced: true }
      state.nextFile = undefined
      if (out instanceof Error) throw out
      if (out.kind === 'stored') {
        let size = 0
        for await (const chunk of body) size += (chunk as Buffer).length
        state.received.push(size)
      }
      return out
    },
    approve: run('approve'),
    unapprove: run('unapprove'),
    reject: run('reject'),
    edit: run('edit'),
    rescript: run('rescript'),
    manualDone: run('manualDone'),
    publishNow: run('publishNow'),
    retry: run('retry'),
    cancel: run('cancel'),
    videoOfPublication: async (id) => (id === 404 ? null : 41),
  }
  return { actions, state }
}
