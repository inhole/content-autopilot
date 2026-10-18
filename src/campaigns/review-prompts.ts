import type { CampaignProfile } from './profile.ts'
import { type Campaign, type ContentType, sourceInfo } from './types.ts'

export type ReviewLimits = { min: number; max: number }

export type ReviewTarget = { source?: string; contentType?: ContentType | null }

/** The extra rule for a video review: the text is the written part that goes with the video. */
const videoNote = (target: ReviewTarget) =>
  target.contentType === 'VIDEO'
    ? '\n- 이 체험단은 영상 리뷰를 요구해. 쓰는 글은 영상과 함께 올리는 글(캡션·본문)이야. 영상을 본다는 전제로 영상 내용을 설명하거나 지어내지 말고, 메모에 있는 사용 경험만 써.'
    : ''

export const reviewSystem = (
  profile: CampaignProfile,
  limits: ReviewLimits,
  target: ReviewTarget = {},
) =>
  `너는 ${sourceInfo(target.source).reviewPlace}를 대신 써 주는 작성자야. 아래 작성자가 직접 써 보고 남기는 짧은 리뷰를 쓴다.

작성자: ${profile.about}
말투: ${profile.review.tone}
${profile.review.points.length ? `리뷰에 담을 관점:\n${profile.review.points.map((p) => `- ${p}`).join('\n')}\n` : ''}
규칙:
- 근거는 작성자의 사용 메모뿐이야. 메모에 없는 경험, 숫자, 효능, 비교, 가격, 기간을 절대 지어내지 마. 메모에 없는 항목은 그냥 쓰지 않는다.
- 상품명과 브랜드는 알려 준 것만 쓴다. 제품 스펙이나 홍보 문구를 상상해서 덧붙이지 마.
- 본문 글자 수는 공백 포함 ${limits.min}자 이상 ${limits.max}자 이하.
- 일반 텍스트만 쓴다. 해시태그, 마크다운, 번호 목록, 따옴표로 감싸기 금지. 이모지는 꼭 필요할 때 한두 개까지만.
- 광고·협찬 표기 문구는 쓰지 마. 그 줄은 코드가 따로 붙인다.
- ${sourceInfo(target.source).reviewPlace}를 보는 사람에게 도움이 되는 솔직한 후기로 쓴다.${videoNote(target)}`

export function reviewUser(
  c: Pick<Campaign, 'title' | 'brand' | 'memo'>,
  opts: { feedback?: string; previous?: string | null } = {},
): string {
  const parts = [
    `상품: ${c.title}`,
    c.brand ? `브랜드: ${c.brand}` : '',
    `\n작성자의 사용 메모:\n${c.memo ?? ''}`,
  ].filter(Boolean)
  if (opts.feedback) {
    if (opts.previous) parts.push(`\n이전 초안:\n${opts.previous}`)
    parts.push(
      `\n작성자의 수정 요청:\n${opts.feedback}\n요청을 반영해 다시 쓰되, 여전히 메모에 있는 사실만 써.`,
    )
  }
  return parts.join('\n')
}

export const shortenReviewPrompt = (text: string, target: number) =>
  `아래 리뷰를 공백 포함 ${target}자 이하로 줄여줘. 핵심 경험과 말투는 유지하고, 새로운 내용은 더하지 마.\n\n${text}`

export const expandReviewPrompt = (text: string, memo: string, min: number, max: number) =>
  `아래 리뷰가 너무 짧아. 공백 포함 ${min}자 이상 ${max}자 이하로 늘려줘. 반드시 아래 사용 메모에 있는 사실만 풀어서 쓰고, 메모에 없는 내용은 더하지 마. 메모에 더 쓸 내용이 없으면 문장을 억지로 늘리지 말고 그대로 둬.\n\n사용 메모:\n${memo}\n\n리뷰:\n${text}`
