import type { OpsJobName, OpsJobState } from './types.ts'

export const OPS_JOBS: Record<
  OpsJobName,
  { label: string; description: string; warning?: string }
> = {
  'threads-daily': {
    label: 'Threads 뉴스 수집',
    description: '수집 → 선별 → 초안 생성. 초안은 Telegram 검수로 가요.',
    warning: 'LLM을 호출하고 새 초안을 만들어요. 비용이 들고, 초안마다 Telegram 검수 메시지가 가요.',
  },
  'gift-collect': {
    label: '카카오톡 선물하기 체험단 수집',
    description: '공개 목록을 읽고 점수를 매겨 후보 카드를 Telegram으로 보내요.',
  },
  'musinsa-collect': {
    label: '무신사 체험단 수집',
    description: '프리유저 공개 목록을 읽고 점수를 매겨 후보 카드를 Telegram으로 보내요.',
  },
  'campaign-maintenance': {
    label: '체험단 마감 정리·리마인더',
    description: '마감된 카드를 정리하고 리마인더를 보내요. 리마인더는 09~21시에만 가요.',
  },
  'collect-insights': {
    label: 'Threads 성과 수집',
    description: '최근 발행한 글의 조회·좋아요·답글 수를 저장해요.',
  },
}

export const OPS_JOB_ORDER: OpsJobName[] = [
  'threads-daily',
  'gift-collect',
  'musinsa-collect',
  'campaign-maintenance',
  'collect-insights',
]

export const OPS_STATE_LABELS: Record<OpsJobState, string> = {
  created: '대기',
  retry: '재시도',
  active: '실행 중',
  completed: '완료',
  cancelled: '취소',
  failed: '실패',
}

export const OPS_STATE_TONES: Record<
  OpsJobState,
  'success' | 'destructive' | 'info' | 'warning' | 'muted'
> = {
  created: 'warning',
  retry: 'warning',
  active: 'info',
  completed: 'success',
  cancelled: 'muted',
  failed: 'destructive',
}

const INT = /^\d{1,2}$/

/**
 * A simple cron (KST) in Korean: `0 9,15,21 * * *` gives 매일 9·15·21시, `0 * * * *` gives
 * 매시 정각, a minute step such as every 10 minutes gives 10분마다. Anything else is returned
 * as the raw expression; null means it only runs on demand.
 */
export function humanizeCron(cron: string | null): string {
  if (cron === null) return '수동 실행만'
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || f[4] !== '*') return cron
  const min = f[0] as string
  const hour = f[1] as string
  if (hour === '*') {
    if (INT.test(min) && Number(min) < 60) return min === '0' ? '매시 정각' : `매시 ${Number(min)}분`
    const step = min.match(/^\*\/(\d{1,2})$/)
    if (step && Number(step[1]) > 0) return `${Number(step[1])}분마다`
    return cron
  }
  const hours = hour.split(',')
  if (!INT.test(min) || Number(min) > 59 || !hours.every((h) => INT.test(h) && Number(h) < 24))
    return cron
  const m = Number(min)
  const list = hours.map(Number).join('·')
  return m === 0 ? `매일 ${list}시` : `매일 ${list}시 ${m}분`
}
