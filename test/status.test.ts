import { describe, expect, it } from 'vitest'
import { formatFinalFailure, isFinalAttempt } from '../src/jobs.ts'
import { formatStatus, type Status } from '../src/pipeline/status.ts'

const base: Status = {
  pendingReview: { count: 2, ids: [4, 5] },
  scheduled: [
    { id: 7, scheduledAt: new Date('2026-10-09T03:00:00Z'), preview: '안녕하세요 테스트 글' },
  ],
  publishedLast24h: 3,
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
