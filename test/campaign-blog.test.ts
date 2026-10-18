import { describe, expect, it } from 'vitest'
import {
  composeBlogBody,
  ensurePhotoPlaceholders,
  findMissingKeywords,
  parseBlogUrl,
  stripLeadingDisclosure,
} from '../src/campaigns/blog.ts'
import { buildSaveTask, parseSaveResult } from '../src/campaigns/blog-save.ts'
import { parseCampaignProfile } from '../src/campaigns/profile.ts'

const DISCLOSURE = '본 포스팅은 레뷰를 통해 제품을 무상으로 제공받아 작성한 솔직한 후기입니다.'
const profile = parseCampaignProfile({
  blog: { url: 'https://blog.naver.com/x', topic: 'IT', tone: '친근한 해요체' },
  types: ['delivery'],
  interests: [],
  excludeKeywords: [],
  applyMessage: { maxChars: 300, points: [] },
  disclosure: DISCLOSURE,
})

describe('composeBlogBody', () => {
  it('puts the disclosure first and keeps the body and placeholders', () => {
    const out = composeBlogBody(profile, { body: '첫 문단입니다.\n\n[사진1]\n\n둘째 문단.' })
    expect(out).toBe(`${DISCLOSURE}\n\n첫 문단입니다.\n\n[사진1]\n\n둘째 문단.`)
  })

  it('removes an identical disclosure the model added, so it appears once', () => {
    const out = composeBlogBody(profile, { body: `${DISCLOSURE}\n\n본문 시작합니다.` })
    expect(out.split(DISCLOSURE).length - 1).toBe(1)
    expect(out).toBe(`${DISCLOSURE}\n\n본문 시작합니다.`)
  })

  it('removes a differently worded disclosure paragraph', () => {
    const out = composeBlogBody(profile, {
      body: '이 글은 업체로부터 제품을 제공받아 작성한 후기입니다.\n\n본문 시작합니다.',
    })
    expect(out).toBe(`${DISCLOSURE}\n\n본문 시작합니다.`)
  })

  it('keeps a normal first paragraph that merely mentions a product', () => {
    const body = '요즘 무선 이어폰을 찾고 있었는데 마침 좋은 기회가 생겼어요.\n\n본문'
    expect(stripLeadingDisclosure(body, DISCLOSURE)).toBe(body)
  })

  it('never strips the only paragraph', () => {
    expect(stripLeadingDisclosure(DISCLOSURE, DISCLOSURE)).toBe(DISCLOSURE)
  })
})

describe('ensurePhotoPlaceholders', () => {
  it('appends only the missing placeholders', () => {
    expect(ensurePhotoPlaceholders('가\n\n[사진1]\n\n나', 3)).toBe(
      '가\n\n[사진1]\n\n나\n\n[사진2]\n\n[사진3]',
    )
    expect(ensurePhotoPlaceholders('가 [사진1]', 1)).toBe('가 [사진1]')
    expect(ensurePhotoPlaceholders('가', 0)).toBe('가')
  })
})

describe('findMissingKeywords', () => {
  it('ignores case and spacing', () => {
    expect(
      findMissingKeywords('무선이어폰 후기, Bluetooth 5', ['무선 이어폰', 'bluetooth']),
    ).toEqual([])
  })
  it('lists the absent ones', () => {
    expect(findMissingKeywords('이어폰 후기', ['이어폰', '노이즈캔슬링', ' '])).toEqual([
      '노이즈캔슬링',
    ])
  })
})

describe('parseSaveResult', () => {
  it('reads SAVED and FAILED lines', () => {
    expect(parseSaveResult('작업 중...\nRESULT: SAVED')).toEqual({ kind: 'saved' })
    expect(parseSaveResult('x\nRESULT: FAILED 저장 버튼을 못 찾음\n')).toEqual({
      kind: 'failed',
      reason: '저장 버튼을 못 찾음',
    })
  })
  it('lets the last RESULT line win', () => {
    expect(parseSaveResult('RESULT: FAILED a\nRESULT: SAVED')).toEqual({ kind: 'saved' })
  })
  it('treats anything else as unknown', () => {
    expect(parseSaveResult(null)).toEqual({ kind: 'unknown' })
    expect(parseSaveResult('저장했습니다')).toEqual({ kind: 'unknown' })
    expect(parseSaveResult('the RESULT: SAVED marker is mid-line')).toEqual({ kind: 'unknown' })
  })
})

describe('buildSaveTask', () => {
  const task = buildSaveTask({
    title: '제목입니다',
    body: '본문 [사진1]',
    photos: ['C:\\p\\1.jpg'],
  })
  it('includes the content, photo paths and the no-publish rule', () => {
    expect(task).toContain('제목입니다')
    expect(task).toContain('본문 [사진1]')
    expect(task).toContain('[사진1] -> C:\\p\\1.jpg')
    expect(task).toContain('절대 발행하지 마라')
    expect(task).toContain('RESULT: SAVED')
  })
})

describe('parseBlogUrl', () => {
  it('accepts Naver blog hosts only', () => {
    expect(parseBlogUrl('https://blog.naver.com/me/223')).toBe('https://blog.naver.com/me/223')
    expect(parseBlogUrl(' https://m.blog.naver.com/me/223 ')).toBe(
      'https://m.blog.naver.com/me/223',
    )
    expect(parseBlogUrl('https://evil.com/blog.naver.com')).toBeNull()
    expect(parseBlogUrl('https://blog.naver.com.evil.com/x')).toBeNull()
    expect(parseBlogUrl('ftp://blog.naver.com/x')).toBeNull()
    expect(parseBlogUrl('not a url')).toBeNull()
  })
})
