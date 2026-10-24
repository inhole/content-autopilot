import type { ActionOutcome, CampaignActions } from '../src/campaigns/actions.ts'

/**
 * In-memory CampaignActions for server tests: every call is recorded, and `next` scripts the
 * outcome of the following call (default: applied, Telegram synced).
 */
export function fakeActions() {
  const state = {
    calls: [] as { name: string; id: number; params: unknown }[],
    next: undefined as ActionOutcome | undefined,
    fail: undefined as Error | undefined,
  }
  const run =
    (name: string) =>
    async (id: number, params: unknown): Promise<ActionOutcome> => {
      state.calls.push({ name, id, params })
      if (state.fail) throw state.fail
      const out = state.next ?? { ok: true, telegramSynced: true }
      state.next = undefined
      return out
    }
  const actions: CampaignActions = {
    apply: run('apply'),
    reject: run('reject'),
    result: run('result'),
    deadline: run('deadline'),
    memo: run('memo'),
    regenerate: run('regenerate'),
    draft: run('draft'),
    posted: run('posted'),
  }
  return { actions, state }
}
