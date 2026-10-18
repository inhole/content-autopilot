import type { CampaignProfile } from './profile.ts'
import type { CampaignDetail } from './types.ts'

export const DEFAULT_BLOG_LENGTH = '공백 포함 1,500~2,500자'

export const BLOG_SYSTEM = `너는 한국어 네이버 블로그 체험단 후기 초안을 쓰는 보조 작성자다. 글쓴이는 블로그 주인 본인이며, 초안을 본인이 검수·수정한 뒤 직접 발행한다.

규칙:
1. 사실의 근거는 [캠페인 정보]와 [사용 메모]뿐이다. 제품 사용 경험, 맛, 착용감, 성능, 효과, 가격 비교, 방문 경험을 메모에 없는 대로 지어내지 마라. 메모가 얇으면 글을 억지로 늘리지 말고 제공 내역과 가이드에 있는 사실, 메모의 느낌을 풀어 쓰는 데 그쳐라.
2. 필수 키워드는 모두 문맥에 맞게 자연스럽게 넣는다. 키워드를 나열하거나 반복해서 도배하지 마라.
3. 사진 자리는 [사진1], [사진2] … 처럼 단독 줄로 표시한다. 주어진 사진 장수만큼 번호를 한 번씩, 설명하는 문단 근처에 둔다.
4. 광고·협찬 고지 문구는 쓰지 마라. 고지는 코드가 글 맨 위에 붙인다.
5. 과장 광고, 의학적 효능 단정, "최고", "100%" 같은 표현을 피한다. 장점만 늘어놓지 말고 메모에 있는 아쉬운 점은 솔직하게 쓴다.
6. 소제목이 필요하면 짧은 줄로 쓰고, 마크다운 기호(#, **)는 쓰지 마라. 네이버 에디터에 그대로 붙여 넣을 평문이다.
7. 제목은 핵심 키워드를 앞쪽에 넣고 40자 안팎으로 쓴다.`

export type BlogPromptInput = {
  detail: CampaignDetail
  keywords: string[]
  profile: CampaignProfile
  memo: string
  photoCount: number
  /** The current draft body, when regenerating with feedback. */
  previousBody?: string | null
  feedback?: string
  /** Keywords a previous attempt left out. */
  missingKeywords?: string[]
}

export function buildBlogUserPrompt(i: BlogPromptInput): string {
  const lines = [
    '[캠페인 정보]',
    `제목: ${i.detail.title}`,
    `제공 내역: ${i.detail.offer}`,
    `유형: ${i.detail.type}${i.detail.category ? ` / ${i.detail.category}` : ''}`,
    `채널: ${i.detail.channel ?? '네이버 블로그'}`,
    `가이드(미션):\n${i.detail.guide}`,
    `필수 키워드: ${i.keywords.length ? i.keywords.join(', ') : '(없음)'}`,
    '',
    '[블로그 성격]',
    `주제: ${i.profile.blog.topic}`,
    `말투: ${i.profile.blog.tone}`,
    '',
    '[사용 메모] (글쓴이가 직접 쓴 내용. 후기의 경험 근거는 이것뿐이다)',
    i.memo.trim() || '(메모 없음)',
    '',
    `사진: ${i.photoCount}장 (${i.photoCount ? `[사진1]~[사진${i.photoCount}]을 본문에 배치` : '사진 자리 표시 없음'})`,
    `분량: 가이드에 글자 수 조건이 있으면 그에 맞추고, 없으면 ${DEFAULT_BLOG_LENGTH}`,
  ]
  if (i.previousBody) {
    lines.push('', '[현재 초안]', i.previousBody)
  }
  if (i.feedback) {
    lines.push('', '[글쓴이의 수정 요청] 현재 초안을 이 요청에 맞게 고쳐 다시 써라.', i.feedback)
  }
  if (i.missingKeywords?.length) {
    lines.push(
      '',
      `[누락된 키워드] 이전 결과에 다음 키워드가 빠졌다. 반드시 자연스럽게 포함해 다시 써라: ${i.missingKeywords.join(', ')}`,
    )
  }
  lines.push('', '출력은 title, body, usedKeywords(본문에 실제로 쓴 필수 키워드) JSON으로 한다.')
  return lines.join('\n')
}
