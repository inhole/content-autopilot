/** Appended to GENERATE_SYSTEM for the weekly digest chain. It overrides the single-post structure. */
export const DIGEST_RULES = `주간 묶음 글 규칙 (이 규칙이 위의 "글 1개" 구성보다 우선한다):
- 이번 주 올리지 못하고 지나간 소식 2~3개를 연결 글 하나로 묶어 쓴다. 본 글(text) 1개와 답글(followups)로 구성하고, 소식 하나가 글 하나를 맡는다: 본 글은 첫 번째 소식, followups[i]는 (i + 2)번째 소식. 소식이 2개면 답글은 1개, 3개면 2개다. 답글 개수는 반드시 소식 수 - 1이다.
- 본 글 첫 줄은 "이번 주 놓친 개발 소식"을 묶어 보여 주는 훅으로 시작한다 (예: "이번 주 못 다룬 개발 소식 몰아서 정리함"). "속보", "충격", "꼭 알아야 할 N가지" 같은 낚시와 번호 매긴 리스트 형식은 쓰지 않는다. 그 다음 첫 번째 소식을 다룬다.
- 본 글의 마지막 줄은 이번에 묶은 소식들과 연결된 구체적인 질문 하나로 끝낸다. 답글에는 질문 마무리를 붙이지 않아도 된다.
- 사실은 각 소식에 주어진 "초안"에 있는 것만 쓴다. 초안은 이미 원문 기사를 근거로 쓴 글이다. 초안에 없는 수치, 날짜, 이름, 인용은 만들지 않는다. 소식 사이를 억지로 연결하는 새 주장도 만들지 않는다.
- 초안을 그대로 베끼지 말고 이 글의 흐름에 맞게 줄여 다시 쓴다. 각 소식은 핵심 하나와 개발자 관점의 한마디만 담는다.
- 본 글과 답글 모두 음슴체(마침표 없이 한 줄에 한 문장)를 지킨다. URL과 해시태그는 본문에 넣지 않는다 (출처 링크는 시스템이 각 글에 붙인다).
- 본 글은 최대 400자, 각 답글은 최대 400자. 마지막 답글 뒤에는 시스템이 고정 문구를 붙이니 팔로우·좋아요 요청은 쓰지 않는다.
- topic_tag는 주제 태그 1개(예: 개발). caveats는 사실 확인이 필요한 항목만 최대 2개, 없으면 빈 배열.`

export type DigestPromptItem = {
  title: string
  text: string
  sourceUrl: string | null
}

/** The user prompt: the items in order, plus the previous version and feedback on a rewrite. */
export function digestUserPrompt(
  items: DigestPromptItem[],
  revision?: { previous: string[]; feedback?: string | undefined },
): string {
  const blocks = items.map(
    (item, i) =>
      `소식 ${i + 1}${i === 0 ? ' (본 글)' : ` (답글 ${i})`}:\n제목: ${item.title}\n출처: ${item.sourceUrl ?? '(없음)'}\n초안:\n${item.text}`,
  )
  const prompt = `이번 주 놓친 소식 ${items.length}개를 연결 글로 묶어라. 답글은 ${items.length - 1}개다.\n\n${blocks.join('\n\n')}`
  if (!revision) return prompt
  const previous = revision.previous.map((t, i) => `이전 ${i === 0 ? '본 글' : `답글 ${i}`}:\n${t}`)
  const feedback = revision.feedback
    ? `\n\n검수자 피드백: ${revision.feedback}\n피드백을 반영해 새로 써라.`
    : '\n\n같은 소식으로 다시 써라.'
  return `${prompt}\n\n${previous.join('\n\n')}${feedback}`
}
