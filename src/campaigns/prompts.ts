import type { CampaignProfile } from './profile.ts'

export const RANK_SYSTEM = `너는 카카오톡 선물하기 체험단 신청을 도와주는 비서다. 후보 체험단이 이 사람에게 맞는지 0~10점으로 평가한다.

평가 기준:
- 프로필의 소개와 관심사에 맞는 제품일수록, 실제로 써보고 후기를 쓸 만한 제품일수록 높은 점수를 준다.
- 경쟁률(신청자 수 / 모집 인원)이 낮을수록 당첨 가능성이 높으므로 가산하고, 높으면 감점한다. 경쟁률이 비슷하면 취향 적합도를 우선한다.
- 최근 신청한 체험단과 비슷하면 가산하고, 거절한 이유와 비슷하면 감점한다.
- 후보에 적힌 정보만 근거로 삼고, 적혀 있지 않은 제품 특성은 추측하지 않는다.
- 모든 후보를 하나도 빠짐없이 평가한다. reason은 한국어 한 문장이다.`

export function profileBlock(profile: CampaignProfile): string {
  return [
    `소개: ${profile.about}`,
    `관심사: ${profile.interests.join(', ') || '(없음)'}`,
    profile.excludeKeywords.length ? `싫어하는 키워드: ${profile.excludeKeywords.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export type RankCandidate = {
  id: number
  title: string
  brand: string | null
  application_count: number | null
  recruit_count: number | null
  remaining_days: number | null
}

export function candidateLine(c: RankCandidate): string {
  const parts = [`[${c.id}] ${c.title}`]
  if (c.brand) parts.push(`브랜드: ${c.brand}`)
  if (c.recruit_count != null && c.application_count != null) {
    const ratio = c.recruit_count > 0 ? (c.application_count / c.recruit_count).toFixed(1) : '?'
    parts.push(`모집 ${c.recruit_count}명 / 신청 ${c.application_count}명 (경쟁률 ${ratio}:1)`)
  }
  if (c.remaining_days != null) parts.push(`남은 기간 ${c.remaining_days}일`)
  return parts.join(' | ')
}

export type RankHistory = {
  applied: { title: string }[]
  rejected: { title: string; reason: string | null }[]
}

export function historyBlock(h: RankHistory): string {
  const applied = h.applied.length ? h.applied.map((a) => `- ${a.title}`).join('\n') : '(없음)'
  const rejected = h.rejected.length
    ? h.rejected.map((r) => `- ${r.title}: ${r.reason ?? '사유 없음'}`).join('\n')
    : '(없음)'
  return `최근 신청한 체험단:\n${applied}\n\n최근 거절한 체험단:\n${rejected}`
}

export function rankUser(opts: {
  profile: CampaignProfile
  history: RankHistory
  candidates: RankCandidate[]
}): string {
  const { profile, history, candidates } = opts
  return `${profileBlock(profile)}

${historyBlock(history)}

후보 ${candidates.length}개를 모두 평가해라. id는 대괄호 안의 숫자다.

${candidates.map(candidateLine).join('\n')}`
}
