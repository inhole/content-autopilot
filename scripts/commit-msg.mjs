// Validates commit messages against docs/conventions.md. Run by .githooks/commit-msg.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'perf']
const MAX_SUBJECT = 72
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?: (\\S.*)$`)
const HANGUL = /[가-힣]/
// Messages git or tooling writes for us.
const EXEMPT = /^(Merge |Revert "|fixup! |squash! |amend! )/

/** Returns a list of problems; an empty list means the message is valid. */
export function checkCommitMessage(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => !l.startsWith('#'))
  while (lines.length && lines[0].trim() === '') lines.shift()
  const subject = lines[0] ?? ''
  if (EXEMPT.test(subject)) return []

  const errors = []
  const match = subject.match(SUBJECT)
  if (!match) {
    errors.push(`요약 줄은 "<type>: <한글 요약>" 형식이어야 합니다. type: ${TYPES.join(', ')}`)
  } else {
    const summary = match[3]
    if (!HANGUL.test(summary)) errors.push('요약은 한글로 작성해야 합니다.')
    if (/[.。]$/.test(summary)) errors.push('요약 끝에 마침표를 붙이지 않습니다.')
  }
  if ([...subject].length > MAX_SUBJECT) {
    errors.push(`요약 줄이 ${MAX_SUBJECT}자를 넘습니다 (${[...subject].length}자).`)
  }
  if (lines.length > 1 && lines[1].trim() !== '') {
    errors.push('요약 줄과 본문 사이에 빈 줄이 필요합니다.')
  }
  return errors
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/commit-msg.mjs <commit-msg-file>')
    process.exit(2)
  }
  const errors = checkCommitMessage(readFileSync(file, 'utf8'))
  if (errors.length) {
    console.error('\n✖ 커밋 메시지가 컨벤션(docs/conventions.md)에 맞지 않습니다.')
    for (const e of errors) console.error(`  - ${e}`)
    console.error('\n  예: feat: Telegram 검수 메시지에 수정 답장 기능 추가\n')
    process.exit(1)
  }
}
