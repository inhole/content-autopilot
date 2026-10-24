import type {
  AddTopicOutcome,
  PostActionOutcome,
  PostActions,
} from '../src/pipeline/post-actions.ts'

/**
 * In-memory PostActions for server tests: every call is recorded, `next` scripts the outcome of
 * the following id action (default: applied, Telegram synced) and `nextAdd` that of addTopic.
 */
export function fakePostActions() {
  const state = {
    calls: [] as { name: string; id?: number; params?: unknown }[],
    next: undefined as PostActionOutcome | undefined,
    nextAdd: undefined as AddTopicOutcome | undefined,
    fail: undefined as Error | undefined,
  }
  const run =
    (name: string) =>
    async (id: number, params?: unknown): Promise<PostActionOutcome> => {
      state.calls.push({ name, id, params })
      if (state.fail) throw state.fail
      const out = state.next ?? { ok: true, telegramSynced: true }
      state.next = undefined
      return out
    }
  const actions: PostActions = {
    approve: run('approve'),
    reject: run('reject'),
    regenerate: run('regenerate'),
    edit: run('edit'),
    deletePart: run('deletePart'),
    unschedule: run('unschedule'),
    publishNow: run('publishNow'),
    retryParts: run('retryParts'),
    revive: run('revive'),
    addTopic: async (params) => {
      state.calls.push({ name: 'addTopic', params })
      if (state.fail) throw state.fail
      const out = state.nextAdd ?? { ok: true, topicId: 77 }
      state.nextAdd = undefined
      return out
    },
    reviveCheck: async () => {
      state.calls.push({ name: 'reviveCheck' })
      if (state.fail) throw state.fail
    },
    digest: async () => {
      state.calls.push({ name: 'digest' })
      if (state.fail) throw state.fail
    },
  }
  return { actions, state }
}
