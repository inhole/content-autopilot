import { describe, expect, it } from 'vitest'
import {
  competitionOf,
  daysUntil,
  formatAge,
  formatCompetition,
  formatDateTime,
  formatDday,
  isAllowedImageUrl,
  isHttpUrl,
  truncate,
} from './format.ts'

describe('formatCompetition', () => {
  it('shows - when unknown', () => {
    expect(formatCompetition(null)).toBe('-')
    expect(formatCompetition(undefined)).toBe('-')
  })
  it('uses one decimal below 10 and thousands separators above', () => {
    expect(formatCompetition(4)).toBe('4.0:1')
    expect(formatCompetition(12.3)).toBe('12:1')
    expect(formatCompetition(1234.4)).toBe('1,234:1')
  })
  it('computes from counts', () => {
    expect(competitionOf({ application_count: 20, recruit_count: 10 })).toBe(2)
    expect(competitionOf({ application_count: 20, recruit_count: 0 })).toBeNull()
    expect(competitionOf({ application_count: null, recruit_count: 5 })).toBeNull()
  })
})

describe('D-n in KST', () => {
  const now = new Date('2026-10-18T16:00:00Z') // 2026-10-19 01:00 KST
  it('counts calendar days in Asia/Seoul', () => {
    expect(daysUntil('2026-10-19T14:59:00Z', now)).toBe(0) // 23:59 KST same day
    expect(daysUntil('2026-10-19T15:01:00Z', now)).toBe(1) // 00:01 KST next day
    expect(daysUntil('2026-10-16T00:00:00Z', now)).toBe(-3)
  })
  it('formats labels', () => {
    expect(formatDday(0)).toBe('D-day')
    expect(formatDday(3)).toBe('D-3')
    expect(formatDday(-2)).toBe('D+2')
  })
})

describe('formatDateTime', () => {
  it('renders Asia/Seoul time', () => {
    expect(formatDateTime('2026-10-18T16:30:00Z')).toBe('2026-10-19 01:30')
  })
  it('handles empty and invalid input', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime('nope')).toBe('-')
  })
})

describe('isAllowedImageUrl', () => {
  it('allows only https images from the known hosts', () => {
    expect(isAllowedImageUrl('https://st.kakaocdn.net/a.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://image.msscdn.net/a.jpg')).toBe(true)
    expect(isAllowedImageUrl('https://gift-s.kakaocdn.net/a.jpg')).toBe(true)
    expect(isAllowedImageUrl('http://st.kakaocdn.net/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('https://evil.example/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('https://st.kakaocdn.net.evil.example/a.jpg')).toBe(false)
    expect(isAllowedImageUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedImageUrl(null)).toBe(false)
  })
  it('only http(s) links', () => {
    expect(isHttpUrl('https://gift.kakao.com/x')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('misc', () => {
  it('truncates by code points', () => {
    expect(truncate('가나다라마', 3)).toBe('가나다…')
    expect(truncate('a  b\nc', 10)).toBe('a b c')
  })
  it('formats age', () => {
    const now = new Date('2026-10-19T12:00:00Z')
    expect(formatAge('2026-10-19T11:59:30Z', now)).toBe('방금')
    expect(formatAge('2026-10-19T10:00:00Z', now)).toBe('2시간 전')
  })
})
