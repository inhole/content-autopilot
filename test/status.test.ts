import { describe, expect, it } from 'vitest'
import { formatFinalFailure, isFinalAttempt } from '../src/jobs.ts'
import { fetchLlmCost, formatStatus, parseLlmCost, type Status } from '../src/pipeline/status.ts'

describe('status extras', () => {
  it('shows expired count and LLM cost only when present', () => {
    expect(formatStatus(base, 'Asia/Seoul')).not.toContain('최근 7일 만료')
    const out = formatStatus(
      { ...base, expiredLast7d: 3, llmCost: { usd: 1.234, period: 'month', limitRemaining: 8.5 } },
      'Asia/Seoul',
    )
    expect(out).toContain('최근 7일 만료: 3건')
    expect(out).toContain('이번 달 LLM 비용: $1.23 (한도 잔여 $8.50)')
    expect(formatStatus({ ...base, llmCost: { usd: 5, period: 'total' } }, 'Asia/Seoul')).toContain(
      'LLM 누적 비용: $5.00',
    )
  })
  it('parses key info, preferring monthly usage', () => {
    expect(parseLlmCost({ data: { usage: 9, usage_monthly: 2, limit: null } })).toEqual({
      usd: 2,
      period: 'month',
      limitRemaining: undefined,
    })
    expect(parseLlmCost({ data: { usage: 9, limit_remaining: 1 } })).toEqual({
      usd: 9,
      period: 'total',
      limitRemaining: 1,
    })
    expect(parseLlmCost({ data: {} })).toBeNull()
    expect(parseLlmCost({ nope: 1 })).toBeNull()
  })
  it('omits the cost on any fetch failure', async () => {
    const boom = (async () => {
      throw new Error('net')
    }) as unknown as typeof fetch
    // '' rather than undefined: undefined would fall back to the real key from config.
    expect(await fetchLlmCost('', boom)).toBeNull()
    expect(await fetchLlmCost('k', boom)).toBeNull()
    const bad = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch
    expect(await fetchLlmCost('k', bad)).toBeNull()
    const ok = (async () =>
      new Response(JSON.stringify({ data: { usage: 3 } }))) as unknown as typeof fetch
    expect(await fetchLlmCost('k', ok)).toMatchObject({ usd: 3 })
  })
})

const base: Status = {
  pendingReview: { count: 2, ids: [4, 5] },
  scheduled: [
    { id: 7, scheduledAt: new Date('2026-10-09T03:00:00Z'), preview: '안녕하세요 테스트 글' },
  ],
  publishedLast24h: 3,
  expiredLast7d: 0,
  failed: [],
  threads: { dryRun: true, tokenExpiresAt: new Date('2026-12-01T00:00:00Z') },
  lastDaily: { state: 'completed', at: new Date('2026-10-08T21:05:00Z') },
}

describe('formatStatus', () => {
  it('shows times in the given zone and the dry-run state', () => {
    const out = formatStatus(base, 'Asia/Seoul')
    expect(out).toContain('Threads: DRY-RUN')
    expect(out).toContain('검수 대기: 2건 (#4, #5)')
    expect(out).toContain('- #7 10-09 12:00 안녕하세요 테스트 글')
    expect(out).toContain('마지막 수집: 10-09 06:05 (completed)')
    expect(out).toContain('최근 24시간 발행: 3건')
    expect(out).not.toContain('실패:')
  })
  it('degrades when optional data is missing and lists failures', () => {
    const out = formatStatus(
      {
        ...base,
        pendingReview: { count: 0, ids: [] },
        scheduled: [],
        lastDaily: undefined,
        threads: { dryRun: false, tokenExpiresAt: null },
        failed: [{ id: 9, lastError: 'x'.repeat(200) }],
      },
      'Asia/Seoul',
    )
    expect(out).toContain('Threads: 실제 발행')
    expect(out).toContain('발행 예정: 없음')
    expect(out).not.toContain('마지막 수집')
    expect(out).toContain('- #9 xxx')
    expect(out).toContain('…')
  })
})

describe('final failure alert', () => {
  it('is final only once retries are exhausted', () => {
    expect(isFinalAttempt(1, 2)).toBe(false)
    expect(isFinalAttempt(2, 2)).toBe(true)
    expect(isFinalAttempt(0, 0)).toBe(true)
  })
  it('formats and truncates the message', () => {
    expect(formatFinalFailure('초안 생성 (topic #12)', new Error('boom\nbad'))).toBe(
      '❌ 초안 생성 (topic #12) 실패 (재시도 소진): boom bad',
    )
    expect(formatFinalFailure('x', 'y'.repeat(400)).length).toBeLessThan(330)
  })
})
