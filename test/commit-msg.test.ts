import { describe, expect, it } from 'vitest'
import { checkCommitMessage } from '../scripts/commit-msg.mjs'

describe('checkCommitMessage', () => {
  it.each([
    'feat: Telegram 검수 메시지에 수정 답장 기능 추가',
    'fix(publish): 컨테이너 만료 시 새 컨테이너로 재발행',
    'docs: README와 문서 추가\n\n본문은 자유롭게 쓴다.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    '# git comment line\nchore: 줄바꿈을 LF로 고정',
    "Merge branch 'main' of github.com:inhole/content-autopilot",
    'fixup! feat: 무언가 추가',
  ])('accepts %j', (msg) => {
    expect(checkCommitMessage(msg)).toEqual([])
  })

  it.each([
    ['Add Threads MVP pipeline', '형식'],
    ['feature: 기능 추가', '형식'],
    ['feat:기능 추가', '형식'],
    ['feat: add pipeline', '한글'],
    ['feat: 기능 추가.', '마침표'],
    [`feat: ${'가'.repeat(80)}`, '72자'],
    ['feat: 기능 추가\n본문이 바로 붙음', '빈 줄'],
  ])('rejects %j', (msg, problem) => {
    expect(checkCommitMessage(msg).join(' ')).toContain(problem)
  })
})
