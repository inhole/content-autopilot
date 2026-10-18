import type { CampaignProfile } from './profile.ts'
import type { CampaignDetail } from './types.ts'

export const DETAIL_SYSTEM = `너는 체험단(리뷰 캠페인) 모집 페이지에서 정보를 뽑아 구조화하는 도우미다.

규칙:
- 페이지에 적힌 내용만 사용한다. 적혀 있지 않은 값은 추측하지 말고 null(또는 빈 배열)로 둔다.
- 날짜와 시간은 한국 표준시(KST) 기준으로 해석해 "YYYY-MM-DDTHH:mm:ss+09:00" 형식으로 쓴다. 연도가 없으면 오늘 날짜를 기준으로 가장 가까운 미래 날짜로 추정한다. 시간이 없으면 마감은 23:59:00, 발표일은 00:00:00으로 둔다.
- type: 제품을 택배로 받으면 "delivery", 매장·현장을 방문하면 "visit", 그 밖에는 "other".
- offer: 리뷰어가 받는 것(제품명, 정가, 포인트 등)을 한 줄로 쓴다.
- rewardWon: offer의 금전적 가치(원). 정가나 금액이 페이지에 없으면 null.
- channel: 리뷰를 올려야 하는 채널(예: "네이버 블로그"). 적혀 있지 않으면 null.
- guide: 리뷰 작성 미션·가이드를 핵심만 간추려 쓴다.
- applyQuestions: 신청 시 입력해야 하는 질문이나 항목이 페이지에 보이면 그대로 담는다.
- keywords: 리뷰에 꼭 넣어야 하는 키워드(해시태그 포함).`

export function detailUser(pageText: string, today: string): string {
  return `오늘 날짜(KST): ${today}\n\n아래 체험단 페이지에서 정보를 추출해라.\n\n${pageText}`
}

export const RANK_SYSTEM = `너는 블로거의 체험단 신청 비서다. 후보 캠페인이 이 블로거에게 맞는지 0~10점으로 평가하고, 신청 메시지 초안을 쓴다.

평가 기준:
- 블로그 주제와 관심사에 맞는 제품일수록, 제공 가치가 클수록, 리뷰 조건(키워드·기한)이 부담 없을수록 높은 점수를 준다.
- 과거에 신청·승인한 캠페인과 비슷하면 가산하고, 거절한 이유와 비슷하면 감점한다.
- 모든 후보를 하나도 빠짐없이 평가한다. reason은 한국어 한 문장이다.

신청 메시지 규칙:
- 한국어, 정중하고 담백한 1인칭. 과장·아부·광고 문구는 쓰지 않는다.
- 이 블로거가 왜 맞는지 구체적으로 쓴다(블로그 주제, 프로필의 강점, 제품과의 접점).
- 후보에 신청 질문(applyQuestions)이 있으면 그 질문에 모두 답한다.
- 프로필에 없는 사실(가족, 직업 세부, 사용 경험 등)은 지어내지 않는다.
- 글자 수 제한을 반드시 지킨다.`

export function profileBlock(profile: CampaignProfile): string {
  return [
    `블로그: ${profile.blog.url}`,
    `주제: ${profile.blog.topic}`,
    `말투: ${profile.blog.tone}`,
    `관심사: ${profile.interests.join(', ') || '(없음)'}`,
    `신청 메시지에 쓸 수 있는 강점:\n${profile.applyMessage.points.map((p) => `- ${p}`).join('\n')}`,
  ].join('\n')
}

export type RankCandidate = {
  id: number
  title: string | null
  category: string | null
  detail: CampaignDetail | null
}

export function candidateBlock(c: RankCandidate): string {
  const d = c.detail
  const lines = [`[${c.id}] ${c.title ?? d?.title ?? '(제목 없음)'}`]
  if (c.category) lines.push(`분류: ${c.category}`)
  if (d) {
    lines.push(`제공: ${d.offer}`)
    if (d.channel) lines.push(`채널: ${d.channel}`)
    if (d.keywords.length) lines.push(`키워드: ${d.keywords.join(', ')}`)
    if (d.guide) lines.push(`가이드: ${d.guide.slice(0, 400)}`)
    if (d.applyQuestions.length) {
      lines.push(`신청 질문:\n${d.applyQuestions.map((q) => `  - ${q}`).join('\n')}`)
    }
  }
  return lines.join('\n')
}

export type RankHistory = {
  accepted: { title: string; category: string | null }[]
  rejected: { title: string; category: string | null; reason: string | null }[]
}

export function historyBlock(h: RankHistory): string {
  const acc = h.accepted.length
    ? h.accepted.map((a) => `- ${a.title}${a.category ? ` (${a.category})` : ''}`).join('\n')
    : '(없음)'
  const rej = h.rejected.length
    ? h.rejected
        .map(
          (r) => `- ${r.title}${r.category ? ` (${r.category})` : ''}: ${r.reason ?? '사유 없음'}`,
        )
        .join('\n')
    : '(없음)'
  return `최근 신청·승인한 캠페인:\n${acc}\n\n최근 거절한 캠페인:\n${rej}`
}

export function rankUser(opts: {
  profile: CampaignProfile
  history: RankHistory
  candidates: RankCandidate[]
}): string {
  const { profile, history, candidates } = opts
  return `${profileBlock(profile)}

신청 메시지 글자 수 제한: ${profile.applyMessage.maxChars}자 이하

${historyBlock(history)}

후보 ${candidates.length}개를 모두 평가하고 각각 신청 메시지를 써라.

${candidates.map(candidateBlock).join('\n\n')}`
}

export const SHORTEN_SYSTEM =
  '너는 한국어 글을 의미는 유지한 채 짧게 줄이는 편집자다. 새로운 사실을 추가하지 않는다.'

export function shortenApplyPrompt(text: string, target: number): string {
  return `아래 체험단 신청 메시지는 너무 길다. 핵심(왜 이 블로거가 맞는지, 질문 답변)을 남기고 ${target}자 이하로 줄여라. 공백과 문장부호도 글자 수에 포함된다.\n\n${text}`
}

export const REWRITE_SYSTEM = `너는 블로거의 체험단 신청 메시지를 고쳐 쓰는 도우미다.

규칙:
- 한국어, 정중하고 담백한 1인칭. 과장·광고 문구 금지.
- 소유자의 피드백을 반영한다.
- 프로필과 캠페인 정보에 없는 사실은 지어내지 않는다.
- 신청 질문이 있으면 모두 답한다.
- 글자 수 제한을 반드시 지킨다.`

export function rewriteUser(opts: {
  profile: CampaignProfile
  candidate: RankCandidate
  current: string
  feedback: string
}): string {
  const { profile, candidate, current, feedback } = opts
  return `${profileBlock(profile)}

신청 메시지 글자 수 제한: ${profile.applyMessage.maxChars}자 이하

캠페인:
${candidateBlock(candidate)}

현재 신청 메시지:
${current}

소유자 피드백:
${feedback}

피드백을 반영해 신청 메시지를 다시 써라.`
}
