import { CheckIcon, PencilIcon, PlayIcon, RotateCcwIcon, TriangleAlertIcon } from 'lucide-react'
import { useRef, useState } from 'react'
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
import { ApiError } from '@/lib/api.ts'
import { formatAge, formatShortDateTime, formatWon } from '@/lib/format.ts'
import {
  humanizeCron,
  OPS_JOB_ORDER,
  OPS_JOBS,
  OPS_STATE_LABELS,
  OPS_STATE_TONES,
} from '@/lib/ops.ts'
import { OPS_POLL_MAX_MS, useOps, useResetProfile, useRunOps } from '@/lib/queries.ts'
import type { OpsJob, OpsJobName, OpsProfile, OpsResponse, OpsSettings } from '@/lib/types.ts'
import { ProfileForm } from '@/pages/ops-profile.tsx'
import { ScheduleCard } from '@/pages/ops-schedule.tsx'
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
        <CardDescription>
          환경 변수로 정해져요. 바꾸려면 값을 고치고 다시 배포해야 해요. (일정과 수량은 위 카드에서
          고쳐요.)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2 text-sm">
          <Row label="연결 글">{onOff(settings.threadChainEnabled)}</Row>
          <Row label="Threads dry-run">
            {settings.threadsDryRun ? (
              <Badge variant="warning">켜짐 (실제로 발행하지 않아요)</Badge>
            ) : (
              '꺼짐'
            )}
          </Row>
          <Row label="선별 방식">
            {RANK_MODES[settings.campaignRankMode]} ({settings.campaignRankMode})
          </Row>
          <Row label="시간대">{settings.timeZone}</Row>
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

export function ProfileCard({
  profile,
  onNotice,
}: {
  profile: OpsProfile | null
  onNotice?: (kind: Notice['kind'], text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const reset = useResetProfile()
  const say = (kind: Notice['kind'], text: string) => onNotice?.(kind, text)
  // The revision shown when the confirmation opened: polling may bring a newer copy while it is
  // open, and resetting on that one would discard it instead of answering 409.
  const resetRevision = useRef(0)
  const doReset = () => {
    if (!profile) return
    reset.mutate(
      { revision: resetRevision.current },
      {
        onSuccess: () => say('ok', '기본 파일 내용으로 되돌렸어요.'),
        onError: (e) =>
          say(
            'error',
            e instanceof ApiError && e.status === 409
              ? '다른 곳에서 먼저 바뀌었어요. 최신 내용을 다시 불러왔어요.'
              : e.message,
          ),
      },
    )
  }
  return (
    <Card data-testid="profile-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          체험단 프로필
          {profile && (
            <Badge variant={profile.source === 'db' ? 'info' : 'outline'}>
              {profile.source === 'db' ? '페이지에서 수정함' : '기본 파일'}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          저장하면 다시 배포하지 않아도 다음 수집·선별과 리뷰 초안부터 바로 반영돼요.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {profile === null ? (
          <p className="text-sm text-muted-foreground">프로필을 읽지 못했어요.</p>
        ) : editing ? (
          <ProfileForm
            profile={profile}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false)
              say('ok', '프로필을 저장했어요. 다음 수집·선별부터 반영돼요.')
            }}
            onError={(m) => say('error', m)}
          />
        ) : (
          <>
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
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon data-icon="inline-start" />
                편집
              </Button>
              {profile.source === 'db' && (
                <Confirm
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={reset.isPending}
                      onClick={() => {
                        resetRevision.current = profile.revision
                      }}
                    >
                      {reset.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <RotateCcwIcon data-icon="inline-start" />
                      )}
                      기본 파일로 되돌리기
                    </Button>
                  }
                  title="기본 파일 내용으로 되돌릴까요?"
                  description="페이지에서 고친 내용이 사라지고 config/campaign-profile.json 내용이 다시 쓰여요."
                  action="되돌리기"
                  onConfirm={doReset}
                />
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function OpsView({
  data,
  runningName,
  onRun,
  onNotice,
  now,
}: {
  data: OpsResponse
  runningName: OpsJobName | null
  onRun: (name: OpsJobName) => void
  onNotice?: (kind: Notice['kind'], text: string) => void
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
        <div className="flex min-w-0 flex-col gap-3">
          <ScheduleCard schedule={data.schedule} onNotice={onNotice} />
          <SettingsCard settings={data.settings} />
        </div>
        <ProfileCard profile={data.profile} onNotice={onNotice} />
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
        description="예약 작업을 지금 실행하고, 일정과 수량·체험단 프로필을 고쳐요"
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
            onNotice={say}
          />
        )}
      </QueryBoundary>
    </>
  )
}
