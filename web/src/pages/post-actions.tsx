import {
  BanIcon,
  CheckIcon,
  PencilIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx'
import { charCount, POST_REJECT_LABELS } from '@/lib/format.ts'
import {
  isPostWatchPending,
  isPostWatchSlow,
  type PostActionVars,
  type PostWatch,
  startPostWatch,
  usePostAction,
} from '@/lib/queries.ts'
import type { PostDetailResponse, PostRejectReason } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

type Detail = PostDetailResponse

const REJECT_ORDER: PostRejectReason[] = ['fact', 'boring', 'topic', 'dup', 'other']

type Notice = { kind: 'ok' | 'error'; text: string }
type Run = (vars: PostActionVars, done: string, watch?: PostWatch['kind']) => void

/** The panel is shown for the statuses that have operations. */
export function hasPostActions(data: Detail): boolean {
  const { post, parts } = data
  if (post.status === 'PENDING_REVIEW' || post.status === 'SCHEDULED') return true
  if (post.status === 'PUBLISHED') return parts.some((p) => p.status === 'FAILED')
  return canRevive(post)
}

/** ♻️ is for expired news drafts that were neither revived nor folded into a digest. */
export const canRevive = (post: Detail['post']) =>
  post.status === 'EXPIRED' &&
  post.origin === 'news' &&
  post.revive.revived_at === null &&
  post.digest_post_id === null

/** Character limit of part `idx`: the last follow-up keeps room for the CTA. */
export function partLimit(data: Detail, idx: number): number {
  const last = data.parts.at(-1)
  return last && last.idx === idx ? data.limits.lastFollowup : data.limits.text
}

export type PostController = {
  data: Detail
  run: Run
  busy: boolean
  notice: Notice | null
  /** A queued regeneration/revival that has not changed the post yet. */
  waiting: PostWatch | null
  slow: boolean
}

/**
 * State shared by the action panel and the per-part editors: one mutation, one notice, and the
 * pending-job watch (regenerate / revive) the page polls on.
 */
export function usePostController(
  data: Detail,
  watch: PostWatch | null,
  onWatch: (watch: PostWatch) => void,
  now?: Date,
): PostController {
  const { post } = data
  const action = usePostAction(post.id)
  const [notice, setNotice] = useState<Notice | null>(null)
  const waiting = isPostWatchPending(watch, post) ? watch : null
  const slow = waiting ? isPostWatchSlow(waiting, (now ?? new Date()).getTime()) : false

  const run: Run = (vars, done, kind) => {
    setNotice(null)
    action.mutate(vars, {
      onSuccess: (res) => {
        if (kind) onWatch(startPostWatch(kind, post))
        setNotice({
          kind: 'ok',
          text: res.telegramSynced ? done : `${done}. 텔레그램 메시지는 갱신하지 못했어요`,
        })
      },
      onError: (error) => setNotice({ kind: 'error', text: error.message }),
    })
  }
  return { data, run, busy: action.isPending || (waiting !== null && !slow), notice, waiting, slow }
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

function RejectButton({ ctrl }: { ctrl: PostController }) {
  const [reason, setReason] = useState<PostRejectReason | ''>('')
  const { post } = ctrl.data
  return (
    <Confirm
      trigger={
        <Button type="button" variant="outline" disabled={ctrl.busy}>
          <BanIcon data-icon="inline-start" />
          폐기
        </Button>
      }
      title="이 글을 폐기할까요?"
      description="폐기하면 되돌릴 수 없어요. 사유는 다음 글 스타일에 참고돼요."
      action="폐기하기"
      disabled={!reason}
      onConfirm={() =>
        reason &&
        ctrl.run(
          { name: 'reject', body: { revision: post.revision, reason } },
          '폐기로 기록했어요',
        )
      }
    >
      <FieldSet>
        <ToggleGroup
          type="single"
          variant="outline"
          className="flex-wrap"
          value={reason}
          onValueChange={(v) => setReason(v as PostRejectReason | '')}
          aria-label="폐기 사유"
        >
          {REJECT_ORDER.map((r) => (
            <ToggleGroupItem key={r} value={r}>
              {POST_REJECT_LABELS[r]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
    </Confirm>
  )
}

function RegenerateButton({ ctrl }: { ctrl: PostController }) {
  const [feedback, setFeedback] = useState('')
  const { post } = ctrl.data
  return (
    <Confirm
      trigger={
        <Button type="button" variant="outline" disabled={ctrl.busy}>
          <RefreshCwIcon data-icon="inline-start" />
          재생성
        </Button>
      }
      title="글을 다시 쓸까요?"
      description="지금 내용은 새 글로 바뀌어요. 고치고 싶은 점을 적으면 반영해서 다시 써요."
      action="다시 쓰기"
      onConfirm={() => {
        const text = feedback.trim()
        ctrl.run(
          {
            name: 'regenerate',
            body: { revision: post.revision, ...(text ? { feedback: text } : {}) },
          },
          '다시 쓰라고 요청했어요',
          'regenerate',
        )
        setFeedback('')
      }}
    >
      <Field>
        <FieldLabel htmlFor="regen-feedback">고칠 점 (선택)</FieldLabel>
        <Textarea
          id="regen-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="비워두면 같은 주제로 새로 써요"
        />
      </Field>
    </Confirm>
  )
}

/**
 * Edit (and, for follow-ups, delete) controls of one part of a draft under review. `idx` 1 is the
 * main post. The counter follows the limit the server enforces; going over disables saving.
 */
export function PartEditControls({
  ctrl,
  idx,
  text,
}: {
  ctrl: PostController
  idx: number
  text: string
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const { post } = ctrl.data
  const limit = partLimit(ctrl.data, idx)
  const count = charCount(value)
  const over = count > limit
  const empty = !value.trim()
  const label = idx === 1 ? '본 글' : `답글 ${idx}`

  return (
    <div className="flex flex-col gap-3">
      {editing ? (
        <Field data-invalid={over || undefined}>
          <FieldLabel htmlFor={`edit-${idx}`}>{label} 수정</FieldLabel>
          <Textarea
            id={`edit-${idx}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            aria-invalid={over || undefined}
          />
          <FieldDescription className={cn('tabular-nums', over && 'text-destructive')}>
            {count}/{limit}자{over && ` · ${count - limit}자 넘었어요`}
          </FieldDescription>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={ctrl.busy || over || empty || value === text}
              onClick={() => {
                ctrl.run(
                  { name: 'edit', body: { revision: post.revision, idx, text: value } },
                  `${label}을 수정했어요`,
                )
                setEditing(false)
              }}
            >
              <CheckIcon data-icon="inline-start" />
              저장
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setValue(text)
                setEditing(false)
              }}
            >
              닫기
            </Button>
          </div>
        </Field>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={ctrl.busy}
            aria-label={`${label} 수정`}
            onClick={() => {
              setValue(text)
              setEditing(true)
            }}
          >
            <PencilIcon data-icon="inline-start" />
            수정
          </Button>
          {idx >= 2 && (
            <Confirm
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={ctrl.busy}
                  aria-label={`${label} 삭제`}
                >
                  <BanIcon data-icon="inline-start" />
                  삭제
                </Button>
              }
              title={`${label}을 삭제할까요?`}
              description="뒤에 있는 답글은 번호가 앞으로 당겨져요. 되돌릴 수 없어요."
              action="삭제하기"
              onConfirm={() =>
                ctrl.run(
                  { name: 'deletePart', body: { revision: post.revision, idx } },
                  `${label}을 삭제했어요`,
                )
              }
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Operations on one post by status (docs/dashboard.md): what the Telegram buttons do. */
export function PostActionsPanel({ ctrl }: { ctrl: PostController }) {
  const { data, notice, waiting, slow } = ctrl
  const { post, parts } = data
  if (!hasPostActions(data) && !waiting && !notice) return null
  const failedParts = parts.some((p) => p.status === 'FAILED')

  return (
    <Card className="gap-3 py-4" data-testid="post-actions">
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

        {waiting && (
          <Alert role="status">
            <Spinner />
            <AlertDescription>
              {slow
                ? `${waiting.kind === 'revive' ? '살리는' : '재생성'} 작업이 오래 걸려요. 텔레그램에 실패 알림이 왔는지 확인하고, 계속 안 되면 다시 요청해 주세요.`
                : waiting.kind === 'revive'
                  ? '살리는 중…이에요. 끝나면 검수 대기로 바뀌어요.'
                  : '재생성 중…이에요. 끝나면 이 화면의 글이 바뀌어요.'}
            </AlertDescription>
          </Alert>
        )}

        {post.status === 'PENDING_REVIEW' && (
          <div className="flex flex-wrap gap-2">
            <Confirm
              trigger={
                <Button type="button" disabled={ctrl.busy}>
                  <CheckIcon data-icon="inline-start" />
                  승인
                </Button>
              }
              title="이 글을 승인할까요?"
              description="다음 빈 발행 시각에 예약돼요. 예약한 뒤에도 취소할 수 있어요."
              action="승인하기"
              onConfirm={() =>
                ctrl.run(
                  { name: 'approve', body: { revision: post.revision } },
                  '승인했어요. 다음 빈 시각에 예약돼요',
                )
              }
            />
            <RegenerateButton ctrl={ctrl} />
            <RejectButton ctrl={ctrl} />
          </div>
        )}

        {post.status === 'SCHEDULED' && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={ctrl.busy || !post.scheduled_at}
              onClick={() =>
                post.scheduled_at &&
                ctrl.run(
                  { name: 'unschedule', body: { scheduledAt: post.scheduled_at } },
                  '예약을 취소했어요. 다시 검수 대기로 돌아가요',
                )
              }
            >
              <Undo2Icon data-icon="inline-start" />
              예약 취소
            </Button>
            <Confirm
              trigger={
                <Button type="button" disabled={ctrl.busy || !post.scheduled_at}>
                  <RocketIcon data-icon="inline-start" />
                  지금 발행
                </Button>
              }
              title="지금 발행할까요?"
              description="발행 시각을 지금으로 당겨요. 발행 점검이 5분마다 돌아서 5분 안에 올라가요."
              action="지금 발행"
              onConfirm={() =>
                post.scheduled_at &&
                ctrl.run(
                  { name: 'publishNow', body: { scheduledAt: post.scheduled_at } },
                  '지금 발행으로 바꿨어요. 5분 안에 올라가요',
                )
              }
            />
          </div>
        )}

        {post.status === 'PUBLISHED' && failedParts && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              발행하지 못한 답글이 있어요. 다시 시도하면 순서대로 이어서 올려요.
            </p>
            <Button
              type="button"
              disabled={ctrl.busy}
              onClick={() => ctrl.run({ name: 'retryParts', body: {} }, '답글을 다시 시도해요')}
            >
              <RotateCcwIcon data-icon="inline-start" />
              답글 다시 시도
            </Button>
          </div>
        )}

        {canRevive(post) && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              시의성 표현을 고쳐 지금 말투로 다시 써서 검수 대기로 올려요.
            </p>
            <Button
              type="button"
              disabled={ctrl.busy}
              onClick={() =>
                ctrl.run({ name: 'revive', body: {} }, '살리라고 요청했어요', 'revive')
              }
            >
              <RotateCcwIcon data-icon="inline-start" />
              살리기
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * ♻️ for a row of the expired list: queues the revival. The row disappears from the list once
 * the post is revived; `onQueued` lets the page say what happens next.
 */
export function ReviveRowButton({
  id,
  title,
  onQueued,
  onError,
}: {
  id: number
  title: string
  onQueued: (telegramSynced: boolean) => void
  onError: (message: string) => void
}) {
  const action = usePostAction(id)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={action.isPending}
      aria-label={`${title} 살리기`}
      onClick={() => {
        action
          .mutateAsync({ name: 'revive', body: {} })
          .then((res) => onQueued(res.telegramSynced))
          .catch((e: Error) => onError(e.message))
      }}
    >
      {action.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
      살리기
    </Button>
  )
}

export { Confirm }
