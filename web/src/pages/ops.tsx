import { CheckIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { formatAge, formatShortDateTime, formatWon } from '@/lib/format.ts'
import {
  humanizeCron,
  OPS_JOB_ORDER,
  OPS_JOBS,
  OPS_STATE_LABELS,
  OPS_STATE_TONES,
} from '@/lib/ops.ts'
import { OPS_POLL_MAX_MS, useOps, useRunOps } from '@/lib/queries.ts'
import type { OpsJob, OpsJobName, OpsProfile, OpsResponse, OpsSettings } from '@/lib/types.ts'
import { Confirm } from '@/pages/post-actions.tsx'

type Notice = { kind: 'ok' | 'error'; text: string }

const RANK_MODES = { rule: '규칙 점수', llm: 'LLM' } as const

const onOff = (v: boolean) => (v ? '켜짐' : '꺼짐')

export function LastRun({ job, now }: { job: OpsJob; now?: Date }) {
  const last = job.last
  if (!last) return <p className="text-sm text-muted-foreground">아직 실행 기록이 없어요.</p>
  const at = last.completed_at ?? last.started_at ?? last.created_at
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={OPS_STATE_TONES[last.state]}>{OPS_STATE_LABELS[last.state]}</Badge>
        <span className="tabular-nums text-muted-foreground">
          {formatShortDateTime(at)} · {formatAge(at, now)}
        </span>
      </div>
      {last.state === 'failed' && last.error && (
        <p className="text-xs break-words text-destructive">{last.error}</p>
      )}
    </div>
  )
}

export function JobCard({
  job,
  running,
  onRun,
  now,
}: {
  job: OpsJob
  running: boolean
  onRun: (name: OpsJobName) => void
  now?: Date
}) {
  const meta = OPS_JOBS[job.name]
  const disabled = job.busy || running
  return (
    <Card data-testid={`job-${job.name}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {meta.label}
          {job.busy && (
            <Badge variant="info">
              <Spinner data-icon="inline-start" />
              대기·실행 중
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="text-muted-foreground">일정 </span>
          {humanizeCron(job.cron)}
        </p>
        <LastRun job={job} now={now} />
        <div>
          <Confirm
            trigger={
              <Button type="button" size="sm" variant="outline" disabled={disabled}>
                {running ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                지금 실행
              </Button>
            }
            title={`${meta.label}을 지금 실행할까요?`}
            description={meta.warning ?? '정해진 일정과 별개로 한 번 더 실행해요.'}
            action="실행하기"
            onConfirm={() => onRun(job.name)}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function SettingsCard({ settings }: { settings: OpsSettings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>설정</CardTitle>
        <CardDescription>환경 변수로 정해져요. 바꾸려면 값을 고치고 다시 배포해야 해요.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2 text-sm">
          <Row label="하루 초안 수">{settings.dailyPostCount}개</Row>
          <Row label="발행 시각">
            {settings.publishSlots.length > 0 ? settings.publishSlots.join(' · ') : '-'}
          </Row>
          <Row label="연결 글">{onOff(settings.threadChainEnabled)}</Row>
          <Row label="Threads dry-run">
            {settings.threadsDryRun ? (
              <Badge variant="warning">켜짐 (실제로 발행하지 않아요)</Badge>
            ) : (
              '꺼짐'
            )}
          </Row>
          <Row label="체험단 하루 최대">출처별 {settings.campaignDailyMax}개</Row>
          <Row label="선별 방식">
            {RANK_MODES[settings.campaignRankMode]} ({settings.campaignRankMode})
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function BadgeList({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">없음</span>
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i} variant="outline">
          {i}
        </Badge>
      ))}
    </span>
  )
}

export function ProfileCard({ profile }: { profile: OpsProfile | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>체험단 프로필</CardTitle>
        <CardDescription>
          읽기 전용이에요. config/campaign-profile.json을 고치고 다시 배포해야 반영돼요.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {profile === null ? (
          <p className="text-sm text-muted-foreground">프로필을 읽지 못했어요.</p>
        ) : (
          <dl className="flex flex-col gap-2 text-sm">
            <Row label="소개">{profile.about || '-'}</Row>
            <Row label="관심사">
              <BadgeList items={profile.interests} />
            </Row>
            <Row label="선호 키워드">
              <BadgeList items={profile.preferKeywords} />
            </Row>
            <Row label="제외 키워드">
              <BadgeList items={profile.excludeKeywords} />
            </Row>
            <Row label="제외 브랜드">
              <BadgeList items={profile.excludeBrands} />
            </Row>
            <Row label="최대 경쟁률">
              {profile.maxCompetition == null ? '제한 없음' : `${profile.maxCompetition}:1`}
            </Row>
            <Row label="최소 가격">
              {profile.minPriceWon == null ? '제한 없음' : formatWon(profile.minPriceWon)}
            </Row>
            <Row label="리뷰 말투">{profile.review.tone}</Row>
            <Row label="리뷰 분량">
              {profile.review.minChars}~{profile.review.maxChars}자
            </Row>
            <Row label="리뷰 포인트">
              <BadgeList items={profile.review.points} />
            </Row>
            <Row label="협찬 문구">{profile.disclosure || '없음'}</Row>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

export function OpsView({
  data,
  runningName,
  onRun,
  now,
}: {
  data: OpsResponse
  runningName: OpsJobName | null
  onRun: (name: OpsJobName) => void
  now?: Date
}) {
  const jobs = OPS_JOB_ORDER.flatMap((n) => data.jobs.find((j) => j.name === n) ?? [])
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        {jobs.map((j) => (
          <JobCard key={j.name} job={j} running={runningName === j.name} onRun={onRun} now={now} />
        ))}
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <SettingsCard settings={data.settings} />
        <ProfileCard profile={data.profile} />
      </div>
    </>
  )
}

export function OpsPage() {
  // Fast polling is allowed for a few minutes after the page opens or a job is started.
  const [pollUntil, setPollUntil] = useState(() => Date.now() + OPS_POLL_MAX_MS)
  const [notice, setNotice] = useState<Notice | null>(null)
  const q = useOps(pollUntil)
  const run = useRunOps()
  const say = (kind: Notice['kind'], text: string) => setNotice({ kind, text })

  const start = (name: OpsJobName) => {
    setNotice(null)
    run.mutate(name, {
      onSuccess: (res) => {
        if (res.queued) {
          setPollUntil(Date.now() + OPS_POLL_MAX_MS)
          say('ok', '실행을 요청했어요. 끝나는 대로 결과가 여기에 보여요.')
        } else {
          say('ok', '이미 대기 중이거나 실행 중이에요.')
        }
      },
      onError: (e) => say('error', e.message),
    })
  }

  return (
    <>
      <PageHeader
        title="운영"
        description="예약 작업을 지금 실행하고, 파이프라인 설정과 체험단 프로필을 확인해요"
      />
      {notice && (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'}>
          {notice.kind === 'error' ? <TriangleAlertIcon /> : <CheckIcon />}
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      <QueryBoundary query={q}>
        {(data) => (
          <OpsView
            data={data}
            runningName={run.isPending ? (run.variables ?? null) : null}
            onRun={start}
          />
        )}
      </QueryBoundary>
    </>
  )
}
