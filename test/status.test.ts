import { describe, expect, it } from 'vitest'
import { formatFinalFailure, isFinalAttempt } from '../src/jobs.ts'
import { formatStatus, type Status } from '../src/pipeline/status.ts'

describe('status extras', () => {
  it('shows the expired count only when present', () => {
    expect(formatStatus(base, 'Asia/Seoul')).not.toContain('최근 7일 만료')
    expect(formatStatus({ ...base, expiredLast7d: 3 }, 'Asia/Seoul')).toContain(
      '최근 7일 만료: 3건',
    )
  })
  it('shows chain part problems only when nonzero', () => {
    expect(formatStatus(base, 'Asia/Seoul')).not.toContain('연결 글')
    const out = formatStatus({ ...base, chainParts: { failed: 2, stuck: 1 } }, 'Asia/Seoul')
    expect(out).toContain('연결 글 답글 실패: 2건')
    expect(out).toContain('연결 글 답글 멈춤: 1건')
  })
  it('shows campaign counts and the last collection', () => {
    const quiet = formatStatus(base, 'Asia/Seoul')
    expect(quiet).toContain('체험단 마지막 수집: 기록 없음')
    expect(quiet).not.toContain('신청함')
    const out = formatStatus(
      {
        ...base,
        campaigns: {
          ...base.campaigns,
          lastCollectedAt: new Date('2026-10-08T21:05:00Z'),
          pendingReview: 2,
          applied: 1,
          draftReview: 1,
          postedLast30d: 4,
        },
      },
      'Asia/Seoul',
    )
    expect(out).toContain('체험단 마지막 수집: 10-09 06:05')
    expect(out).toContain('검수 대기: 2건')
    expect(out).toContain('신청함·결과 대기: 1건')
    expect(out).toContain('리뷰 초안: 1건')
    expect(out).toContain('최근 30일 리뷰 완료: 4건')
    expect(out).not.toContain('선정·리뷰 전')
    expect(out).not.toContain('로컬 워커')
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
  chainParts: { failed: 0, stuck: 0 },
  threads: { dryRun: true, tokenExpiresAt: new Date('2026-12-01T00:00:00Z') },
  lastDaily: { state: 'completed', at: new Date('2026-10-08T21:05:00Z') },
  campaigns: {
    lastCollectedAt: null,
    pendingReview: 0,
    applied: 0,
    selected: 0,
    draftReview: 0,
    postedLast30d: 0,
  },
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
    expect(out).not.toMatch(/^마지막 수집/m)
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
