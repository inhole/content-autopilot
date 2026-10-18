import { describe, expect, it } from 'vitest'
import { NOT_SELECTED_AFTER_DAYS } from '../src/campaigns/selection.ts'

// The selection transitions need a database; see test/integration/campaign-selection.test.ts.
describe('selection rules', () => {
  it('waits two days past the announcement before calling a campaign lost', () => {
    expect(NOT_SELECTED_AFTER_DAYS).toBe(2)
  })
})
