import { describe, expect, it } from 'vitest'
import { decideAfterFailedAttempt, describeSubmitResult } from '../src/campaigns/apply.ts'
import {
  APPLY_SCRIPT,
  LIST_MY_CAMPAIGN_IDS_SCRIPT,
  SCREENSHOT_SCRIPT,
} from '../src/campaigns/revu-scripts.ts'
import { MAX_CLAIM_ATTEMPTS } from '../src/campaigns/types.ts'

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => unknown

describe('decideAfterFailedAttempt', () => {
  it('retries until the attempts run out', () => {
    expect(decideAfterFailedAttempt(1)).toBe('retry')
    expect(decideAfterFailedAttempt(MAX_CLAIM_ATTEMPTS - 1)).toBe('retry')
    expect(decideAfterFailedAttempt(MAX_CLAIM_ATTEMPTS)).toBe('failed')
    expect(decideAfterFailedAttempt(MAX_CLAIM_ATTEMPTS + 1)).toBe('failed')
  })
})

describe('describeSubmitResult', () => {
  it('explains each kind of non-result', () => {
    expect(describeSubmitResult(null)).toContain('결과')
    expect(describeSubmitResult({ submitted: false, reason: '버튼 없음' })).toContain('버튼 없음')
    expect(describeSubmitResult({ submitted: false })).toBe('신청하지 못했어요')
    expect(describeSubmitResult({ submitted: true })).toContain('확인되지 않아요')
  })
})

describe('revu scripts', () => {
  it('are syntactically valid async function bodies', () => {
    for (const body of [
      LIST_MY_CAMPAIGN_IDS_SCRIPT('request'),
      LIST_MY_CAMPAIGN_IDS_SCRIPT('accepted'),
      APPLY_SCRIPT('123', 'hi'),
      SCREENSHOT_SCRIPT('https://www.revu.net/campaign/1', 'a.png'),
    ]) {
      expect(() => new AsyncFunction('openTab', body)).not.toThrow()
    }
  })

  it('open the right pages', () => {
    expect(LIST_MY_CAMPAIGN_IDS_SCRIPT('request')).toContain(
      '"https://www.revu.net/mypage/campaigns?status=request"',
    )
    expect(APPLY_SCRIPT('987', 'x')).toContain('"https://www.revu.net/campaign/987"')
  })

  it('embed messages safely, whatever quotes and newlines they contain', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${x} is the point of the test
    const nasty = 'a "quoted" `tick` ${x} \\ back\nnew line </script>'
    const body = APPLY_SCRIPT('1', nasty)
    expect(body).toContain(JSON.stringify(nasty))
    expect(() => new AsyncFunction('openTab', body)).not.toThrow()
    // The message appears only inside its JSON.stringify literal.
    expect(body.split(JSON.stringify(nasty))).toHaveLength(2)
  })

  it('embed a hostile id as a plain string literal', () => {
    const body = APPLY_SCRIPT('1"; process.exit(1); "', 'x')
    expect(() => new AsyncFunction('openTab', body)).not.toThrow()
    expect(body).toContain(JSON.stringify('https://www.revu.net/campaign/1"; process.exit(1); "'))
  })
})
