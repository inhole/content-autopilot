import {
  BanIcon,
  CalendarIcon,
  CheckIcon,
  FrownIcon,
  PartyPopperIcon,
  PencilIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx'
import { type CampaignActionVars, DRAFT_SLOW_MS, isDraftPending, useCampaignAction } from '@/lib/queries.ts'
import type { CampaignActionRequests, CampaignDetailResponse } from '@/lib/types.ts'

type RejectReason = CampaignActionRequests['reject']['reason']

/** Same reasons as the Telegram pass buttons (CAMPAIGN_REJECT_REASONS in src/campaigns/types.ts). */
const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: 'category', label: '관심 없는 품목' },
  { value: 'competition', label: '경쟁률이 너무 높음' },
  { value: 'brand', label: '브랜드·품질이 불안함' },
  { value: 'other', label: '기타' },
]

type Notice = { kind: 'ok' | 'error'; text: string }

type Run = (vars: CampaignActionVars, done: string) => void

/** The statuses that have operations; the panel is hidden for every other one. */
export const ACTIONABLE_STATUSES = [
  'PENDING_REVIEW',
  'APPLIED',
  'SELECTED',
  'DRAFT_REVIEW',
] as const

export function hasCampaignActions(status: string): boolean {
  return (ACTIONABLE_STATUSES as readonly string[]).includes(status)
}

function Confirm({
  trigger,
  title,
  description,
  action,
  onConfirm,
  disabled,
  children,
}: {
  trigger: ReactNode
  title: string
  description: string
  action: string
  onConfirm: () => void
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RejectButton({ revision, busy, run }: { revision: number; busy: boolean; run: Run }) {
  const [reason, setReason] = useState<RejectReason | ''>('')
  return (
    <Confirm
      trigger={
        <Button type="button" variant="outline" disabled={busy}>
          <BanIcon data-icon="inline-start" />
          패스
        </Button>
      }
      title="이 체험단을 패스할까요?"
      description="패스하면 되돌릴 수 없어요. 사유는 다음 선별에 참고돼요."
      action="패스하기"
      disabled={!reason}
      onConfirm={() =>
        reason && run({ name: 'reject', body: { revision, reason } }, '패스로 기록했어요')
      }
    >
      <FieldSet>
        <ToggleGroup
          type="single"
          variant="outline"
          className="flex-wrap"
          value={reason}
          onValueChange={(v) => setReason(v as RejectReason | '')}
          aria-label="패스 사유"
        >
          {REJECT_REASONS.map((r) => (
            <ToggleGroupItem key={r.value} value={r.value}>
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
    </Confirm>
  )
}

function DeadlineForm({
  status,
  busy,
  run,
}: {
  status: string
  busy: boolean
  run: Run
}) {
  const [date, setDate] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (date.trim()) {
      run(
        { name: 'deadline', body: { status: status as never, date: date.trim() } },
        '리뷰 기한을 기록했어요',
      )
    }
  }
  return (
    <form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="review-deadline">리뷰 기한</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="review-deadline"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            placeholder="10/30 또는 2026-10-30"
            inputMode="text"
            autoComplete="off"
          />
          <Button type="submit" variant="outline" disabled={busy || !date.trim()}>
            <CalendarIcon data-icon="inline-start" />
            기한 저장
          </Button>
        </div>
        <FieldDescription>
          텔레그램 /due 와 같은 형식이에요 (10/30, 10-30, 10.30, 2026-10-30). 그날 끝까지로 기록해요.
        </FieldDescription>
      </Field>
    </form>
  )
}

function MemoForm({
  campaign: c,
  busy,
  run,
}: {
  campaign: CampaignDetailResponse['campaign']
  busy: boolean
  run: Run
}) {
  const [memo, setMemo] = useState(c.memo ?? '')
  const redo = c.status === 'DRAFT_REVIEW'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!memo.trim()) return
    run(
      { name: 'memo', body: { status: c.status, revision: c.revision, memo } },
      redo ? '메모를 저장하고 초안을 다시 쓰고 있어요' : '초안을 쓰고 있어요',
    )
  }
  return (
    <form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="review-memo">사용 메모</FieldLabel>
        <Textarea
          id="review-memo"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={5}
          maxLength={2000}
          placeholder="써본 기간, 좋았던 점, 아쉬운 점, 사진에 담은 것 등"
        />
        <FieldDescription>메모에 적은 내용만으로 리뷰 초안을 써요.</FieldDescription>
        <div>
          <Button type="submit" disabled={busy || !memo.trim()}>
            <SparklesIcon data-icon="inline-start" />
            {redo ? '메모 저장하고 다시 쓰기' : '초안 만들기'}
          </Button>
        </div>
      </Field>
    </form>
  )
}

function DraftControls({
  campaign: c,
  busy,
  run,
}: {
  campaign: CampaignDetailResponse['campaign']
  busy: boolean
  run: Run
}) {
  const [feedback, setFeedback] = useState('')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(c.draft_text ?? '')
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="review-feedback">다시 쓰기</FieldLabel>
        <Textarea
          id="review-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="고치고 싶은 점 (비워두면 같은 메모로 다시 써요)"
        />
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(
                { name: 'regenerate', body: { revision: c.revision, feedback } },
                '초안을 다시 쓰고 있어요',
              )
            }
          >
            <RefreshCwIcon data-icon="inline-start" />
            다시 쓰기
          </Button>
        </div>
      </Field>

      {editing ? (
        <Field>
          <FieldLabel htmlFor="review-edit">초안 직접 수정</FieldLabel>
          <Textarea
            id="review-edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
          />
          <FieldDescription>
            협찬 문구는 코드가 맨 앞에 맞춰 줘요. {[...text].length}자
          </FieldDescription>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() =>
                run({ name: 'draft', body: { revision: c.revision, text } }, '수정한 초안을 저장했어요')
              }
            >
              <CheckIcon data-icon="inline-start" />
              저장
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              닫기
            </Button>
          </div>
        </Field>
      ) : (
        <div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            <PencilIcon data-icon="inline-start" />
            초안 직접 수정
          </Button>
        </div>
      )}

      <Separator />
      <div>
        <Confirm
          trigger={
            <Button type="button" disabled={busy}>
              <PartyPopperIcon data-icon="inline-start" />
              리뷰 올림
            </Button>
          }
          title="리뷰를 올렸다고 기록할까요?"
          description="쇼핑몰에 리뷰를 붙여 넣은 뒤에 눌러 주세요. 기록하면 되돌릴 수 없어요."
          action="올렸어요"
          onConfirm={() => run({ name: 'posted', body: { revision: c.revision } }, '리뷰 완료로 기록했어요')}
        />
      </div>
    </FieldGroup>
  )
}

/** Operations on one campaign by status (docs/dashboard.md): what the Telegram buttons do. */
export function CampaignActionsPanel({ data, now }: { data: CampaignDetailResponse; now?: Date }) {
  const c = data.campaign
  const action = useCampaignAction(c.id)
  const [notice, setNotice] = useState<Notice | null>(null)
  if (!hasCampaignActions(c.status)) return null

  const run: Run = (vars, done) => {
    setNotice(null)
    action.mutate(vars, {
      onSuccess: (res) =>
        setNotice({
          kind: 'ok',
          text: res.telegramSynced
            ? done
            : `${done}. 텔레그램 카드는 갱신하지 못했어요`,
        }),
      onError: (error) => setNotice({ kind: 'error', text: error.message }),
    })
  }
  const busy = action.isPending
  const pending = isDraftPending(c)
  const waitedMs = (now ?? new Date()).getTime() - new Date(c.updated_at).getTime()

  return (
    <Card className="gap-3 py-4" data-testid="campaign-actions">
      <CardHeader className="px-4">
        <CardTitle>작업</CardTitle>
        <CardDescription>텔레그램 버튼과 같은 동작이에요</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4">
        {notice && (
          <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'}>
            {notice.kind === 'error' ? <TriangleAlertIcon /> : <CheckIcon />}
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}

        {c.status === 'PENDING_REVIEW' && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => run({ name: 'apply', body: { revision: c.revision } }, '신청으로 기록했어요')}
            >
              <CheckIcon data-icon="inline-start" />
              신청함
            </Button>
            <RejectButton revision={c.revision} busy={busy} run={run} />
          </div>
        )}

        {c.status === 'APPLIED' && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => run({ name: 'result', body: { selected: true } }, '선정으로 기록했어요')}
            >
              <PartyPopperIcon data-icon="inline-start" />
              선정
            </Button>
            <Confirm
              trigger={
                <Button type="button" variant="outline" disabled={busy}>
                  <FrownIcon data-icon="inline-start" />
                  미선정
                </Button>
              }
              title="미선정으로 기록할까요?"
              description="기록하면 되돌릴 수 없어요."
              action="미선정으로 기록"
              onConfirm={() =>
                run({ name: 'result', body: { selected: false } }, '미선정으로 기록했어요')
              }
            />
          </div>
        )}

        {(c.status === 'SELECTED' || c.status === 'DRAFT_REVIEW') && (
          <>
            {pending && (
              <Alert role="status">
                <Spinner />
                <AlertDescription>
                  {waitedMs > DRAFT_SLOW_MS
                    ? '초안 작성이 오래 걸려요. 텔레그램에 실패 알림이 왔는지 확인하고, 계속 안 되면 다시 요청해 주세요.'
                    : '초안 작성 중이에요. 끝나면 이 화면에 나타나요.'}
                </AlertDescription>
              </Alert>
            )}
            <DeadlineForm status={c.status} busy={busy} run={run} />
            <Separator />
            <MemoForm
              key={`${c.id}-${c.revision}-${c.memo ?? ''}`}
              campaign={c}
              busy={busy || (pending && waitedMs <= DRAFT_SLOW_MS)}
              run={run}
            />
            {c.status === 'DRAFT_REVIEW' && (
              <>
                <Separator />
                <DraftControls
                  key={`${c.id}-${c.revision}`}
                  campaign={c}
                  busy={busy || (pending && waitedMs <= DRAFT_SLOW_MS)}
                  run={run}
                />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
