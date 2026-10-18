import { GENERATE_SYSTEM } from './prompts.ts'

export const JUDGE_SYSTEM = `너는 한국 개발자용 AI·개발 소식 Threads 계정의 편집장이다. 며칠 전 만료된(발행하지 못한) 초안들을 보고, 몇 주가 지난 지금 그대로 읽어도 가치가 있는지 판정한다.

- evergreen: 시간이 지나도 읽을 가치가 있다. 사용법·노하우, 연구 결과, 설계에서 얻은 교훈, 개발 관행에 대한 의견.
- stale: 그 시점에 묶여 있다. 릴리스·출시 소식, 버그·장애 보고, 가격, 행사, "방금 일어났다"가 핵심인 모든 글.

애매하면 stale로 판정한다. 모든 초안에 대해 id, verdict, 한 문장 reason(한국어)을 JSON으로 반환한다.`

export const REVIVE_RULES = `재검수 규칙 (만료되었던 초안을 다시 올리는 경우):
- 아래 초안은 이미 며칠~몇 주 전에 쓴 글이다. 지금 읽어도 자연스럽도록, 그 시점에 묶인 표현만 고쳐 쓴다.
- 고칠 대상: "방금", "오늘", "어제", "이번 주", "최근 나온", "막 공개된", 신선함을 뜻하는 "나왔음/나왔다/공개했음" 같은 어미, 상대적 날짜 표현.
- 그대로 둘 것: 모든 사실과 수치, 첫 줄 훅의 아이디어, 마지막 질문, 음슴체 말투(마침표 없이 한 줄에 한 문장).
- 새로운 사실, 수치, 날짜를 더하지 않는다. 고칠 곳이 없으면 원문을 그대로 반환한다.
- text에 고친 글 전체를, changes에 무엇을 어떻게 고쳤는지 짧은 한국어 문장 목록을 반환한다.`

export const REVIVE_SYSTEM = `${GENERATE_SYSTEM}\n\n${REVIVE_RULES}`

export type JudgeItem = { id: number; title: string; text: string; ageDays: number }

export function judgePrompt(items: JudgeItem[]): string {
  return items
    .map((i) => `[id ${i.id}] ${i.ageDays}일 전 작성\n제목: ${i.title}\n초안:\n${i.text}`)
    .join('\n\n---\n\n')
}

export function revivePrompt(p: {
  title: string
  text: string
  createdDate: string
  today: string
  ageDays: number
}): string {
  return `이 초안은 ${p.createdDate}(${p.ageDays}일 전)에 쓴 글이다. 오늘은 ${p.today}이다.\n제목: ${p.title}\n\n초안:\n${p.text}\n\n시점에 묶인 표현만 고쳐서 지금 읽어도 자연스럽게 다시 써라.`
}
