import {
  ArrowLeftIcon,
  BanIcon,
  CheckIcon,
  ExternalLinkIcon,
  FilmIcon,
  RefreshCwIcon,
  RocketIcon,
  TriangleAlertIcon,
  Undo2Icon,
  UploadIcon,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CopyButton } from '@/components/copy-button.tsx'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import {
  PublicationBadge,
  VideoOriginBadge,
  VideoStatusBadge,
} from '@/components/status-badge.tsx'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx'
import { Field as FormField, FieldDescription, FieldLabel } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ApiError, uploadVideoFile } from '@/lib/api.ts'
import {
  charCount,
  formatBytes,
  formatDateTime,
  formatDuration,
  isHttpUrl,
} from '@/lib/format.ts'
import { refreshVideoData, useVideo, useVideoAction, type VideoActionVars } from '@/lib/queries.ts'
import type { VideoDetailResponse, VideoPublication } from '@/lib/types.ts'
import { DetailSkeleton, Field, FieldList, parseId, Section } from '@/pages/campaign-detail.tsx'
import { useQueryClient } from '@tanstack/react-query'

type Detail = VideoDetailResponse
type Notice = { kind: 'ok' | 'error'; text: string }

const when = (iso: string | null) => <span className="tabular-nums">{formatDateTime(iso)}</span>

/** Splits `#AI, 개발 #도구` into tags (the server drops `#` and duplicates). */
export const parseHashtags = (raw: string) =>
  raw
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, ''))
    .filter(Boolean)

export type VideoController = {
  data: Detail
  run: (vars: VideoActionVars, done: string) => void
  busy: boolean
  notice: Notice | null
}

function useVideoController(data: Detail): VideoController {
  const action = useVideoAction(data.video.id)
  const [notice, setNotice] = useState<Notice | null>(null)
  const run = (vars: VideoActionVars, done: string) => {
    setNotice(null)
    action.mutate(vars, {
      onSuccess: (res) =>
        setNotice({
          kind: 'ok',
          text: res.telegramSynced ? done : `${done}. 텔레그램 메시지는 갱신하지 못했어요`,
        }),
      onError: (error) => setNotice({ kind: 'error', text: error.message }),
    })
  }
  return { data, run, busy: action.isPending, notice }
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

/** The player, only for a public https file (the local storage of development has none). */
function Player({ video }: { video: Detail['video'] }) {
  if (!video.video_url) {
    return <p className="text-sm text-muted-foreground">아직 영상 파일이 없어요.</p>
  }
  if (!isHttpUrl(video.video_url)) {
    return <p className="text-sm text-muted-foreground">로컬 저장소라 미리보기가 없어요.</p>
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: the owner's own preview, no captions exist
    <video
      src={video.video_url}
      controls
      playsInline
      preload="metadata"
      className="aspect-[9/16] max-h-[70vh] w-full max-w-xs rounded-lg bg-black"
    />
  )
}

function NoticeAlert({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return (
    <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
      {notice.kind === 'error' ? <TriangleAlertIcon /> : <CheckIcon />}
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  )
}

/** Approve / reject / rescript under review; unapprove and the manual handoff once approved. */
function ActionsPanel({ ctrl }: { ctrl: VideoController }) {
  const { video, publications } = ctrl.data
  const [feedback, setFeedback] = useState('')
  const rev = { revision: video.revision }
  const untouched = publications.every((p) => p.status === 'SCHEDULED' && p.claim_seq === 0)
  let body: ReactNode = null
  if (video.status === 'PENDING_REVIEW') {
    body = (
      <div className="flex flex-wrap gap-2">
        <Confirm
          trigger={
            <Button type="button" size="sm" disabled={ctrl.busy}>
              <CheckIcon data-icon="inline-start" />
              승인
            </Button>
          }
          title="이 영상을 승인할까요?"
          description="다음 빈 영상 슬롯에 예약해요. 자동 발행 플랫폼이 없으면 직접 올리기 안내가 텔레그램으로 와요."
          action="승인"
          onConfirm={() => ctrl.run({ kind: 'video', name: 'approve', body: rev }, '승인했어요')}
        />
        {video.origin === 'generated' && (
          <Confirm
            trigger={
              <Button type="button" size="sm" variant="outline" disabled={ctrl.busy}>
                <RefreshCwIcon data-icon="inline-start" />
                다시 만들기
              </Button>
            }
            title="원고부터 다시 만들까요?"
            description="피드백을 남기면 반영해서 다시 써요."
            action="다시 만들기"
            onConfirm={() =>
              ctrl.run(
                {
                  kind: 'video',
                  name: 'rescript',
                  body: { ...rev, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) },
                },
                '원고를 다시 쓰는 중이에요',
              )
            }
          >
            <Textarea
              aria-label="피드백"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="예: 훅을 더 세게"
            />
          </Confirm>
        )}
        <Confirm
          trigger={
            <Button type="button" size="sm" variant="outline" disabled={ctrl.busy}>
              <BanIcon data-icon="inline-start" />
              폐기
            </Button>
          }
          title="이 영상을 폐기할까요?"
          description="폐기한 영상은 며칠 뒤 파일도 지워져요."
          action="폐기"
          onConfirm={() => ctrl.run({ kind: 'video', name: 'reject', body: rev }, '폐기했어요')}
        />
      </div>
    )
  } else if (video.status === 'APPROVED') {
    body = (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {publications.length === 0 && (
            <Button
              type="button"
              size="sm"
              disabled={ctrl.busy}
              onClick={() =>
                ctrl.run({ kind: 'video', name: 'manualDone', body: rev }, '직접 올림으로 기록했어요')
              }
            >
              <UploadIcon data-icon="inline-start" />
              직접 올림 완료
            </Button>
          )}
          {untouched && (
            <Confirm
              trigger={
                <Button type="button" size="sm" variant="outline" disabled={ctrl.busy}>
                  <Undo2Icon data-icon="inline-start" />
                  승인 취소
                </Button>
              }
              title="승인을 취소할까요?"
              description="예약을 지우고 검수 대기로 돌아가요. 그다음 폐기하거나 고쳐서 다시 승인할 수 있어요."
              action="승인 취소"
              onConfirm={() =>
                ctrl.run({ kind: 'video', name: 'unapprove', body: rev }, '승인을 취소했어요')
              }
            />
          )}
        </div>
        {!untouched && (
          <p className="text-xs text-muted-foreground">
            발행을 시작한 뒤라 승인을 취소할 수 없어요. 발행별로 다시 시도하거나 중단하세요.
          </p>
        )}
      </div>
    )
  } else if (video.status === 'SCRIPTING' || video.status === 'RENDERING') {
    body = (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {video.status === 'SCRIPTING' ? '원고를 쓰는 중이에요' : '영상을 만드는 중이에요'}
      </p>
    )
  } else if (video.status === 'UPLOADING') {
    body = <FileRetry ctrl={ctrl} />
  }
  if (!body && !ctrl.notice) return null
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>할 일</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {body}
        <NoticeAlert notice={ctrl.notice} />
      </CardContent>
    </Card>
  )
}

/** An UPLOADING row without a file: send one again (the row expires an hour after the last try). */
function FileRetry({ ctrl }: { ctrl: VideoController }) {
  const client = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = ctrl.data.video.id
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      await uploadVideoFile(id, file, false, (loaded, total) => setProgress(loaded / total))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '올리지 못했어요')
    } finally {
      setProgress(null)
      void refreshVideoData(client, id)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        파일을 아직 받지 못했어요. 한 시간 안에 다시 올리지 않으면 만료돼요.
      </p>
      <Input
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        aria-label="영상 파일"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <Button type="submit" size="sm" className="w-fit" disabled={!file || progress !== null}>
        {progress !== null && <Spinner data-icon="inline-start" />}
        {progress !== null ? `올리는 중 ${Math.round(progress * 100)}%` : '파일 올리기'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  )
}

/** Title, caption and hashtags: one form, saved together (revision once). */
function MetaEditor({ ctrl }: { ctrl: VideoController }) {
  const { video, limits } = ctrl.data
  const [title, setTitle] = useState(video.title ?? '')
  const [caption, setCaption] = useState(video.caption ?? '')
  const [tags, setTags] = useState(video.hashtags.map((t) => `#${t}`).join(' '))
  const hashtags = parseHashtags(tags)
  const titleLen = charCount(title.trim())
  const invalid =
    !title.trim() || titleLen > limits.title || new Set(hashtags).size > limits.hashtags
  const dirty =
    title !== (video.title ?? '') ||
    caption !== (video.caption ?? '') ||
    hashtags.join(' ') !== video.hashtags.join(' ')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (invalid || !dirty) return
    ctrl.run(
      { kind: 'video', name: 'edit', body: { revision: video.revision, title, caption, hashtags } },
      '저장했어요',
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <FormField>
        <FieldLabel htmlFor="video-title">제목</FieldLabel>
        <Input id="video-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <FieldDescription className="tabular-nums">
          {titleLen}/{limits.title}자 · YouTube 제목
        </FieldDescription>
      </FormField>
      <FormField>
        <FieldLabel htmlFor="video-caption">캡션</FieldLabel>
        <Textarea
          id="video-caption"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={5}
        />
      </FormField>
      <FormField>
        <FieldLabel htmlFor="video-tags">해시태그</FieldLabel>
        <Input id="video-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        <FieldDescription>띄어쓰기로 나눠요 · {limits.hashtags}개까지</FieldDescription>
      </FormField>
      <Button type="submit" size="sm" className="w-fit" disabled={invalid || !dirty || ctrl.busy}>
        저장
      </Button>
    </form>
  )
}

function PublicationRow({ ctrl, p }: { ctrl: VideoController; p: VideoPublication }) {
  const [checked, setChecked] = useState(false)
  const unknown = p.error_kind === 'session'
  const guard = { claimSeq: p.claim_seq, ...(unknown ? { confirmedNotOnChannel: checked } : {}) }
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`publication-${p.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PublicationBadge platform={p.platform} status={p.status} />
        <span className="text-muted-foreground">
          {p.published_at ? '발행' : '예약'} {when(p.published_at ?? p.scheduled_at)}
        </span>
        {p.attempts > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">시도 {p.attempts}회</span>
        )}
        {isHttpUrl(p.permalink) && (
          <a
            href={p.permalink}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
          >
            보기
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
        )}
      </div>
      {p.last_error && p.status !== 'PUBLISHED' && (
        <p className="text-xs break-words text-destructive">{p.last_error}</p>
      )}
      {p.status === 'SCHEDULED' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          disabled={ctrl.busy}
          onClick={() =>
            ctrl.run(
              {
                kind: 'publication',
                publicationId: p.id,
                name: 'publishNow',
                body: { scheduledAt: p.scheduled_at },
              },
              '곧 발행해요 (5분 안)',
            )
          }
        >
          <RocketIcon data-icon="inline-start" />
          지금 발행
        </Button>
      )}
      {p.status === 'FAILED' && (
        <div className="flex flex-col gap-2">
          {unknown && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span>
                이전 업로드가 끝났는지 몰라요. YouTube Studio에서 채널에 올라가지 않은 것을
                확인했어요.
              </span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={ctrl.busy || (unknown && !checked)}
              onClick={() =>
                ctrl.run(
                  { kind: 'publication', publicationId: p.id, name: 'retry', body: guard },
                  '다시 예약했어요',
                )
              }
            >
              <RefreshCwIcon data-icon="inline-start" />
              다시 시도
            </Button>
            <Confirm
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={ctrl.busy || (unknown && !checked)}
                >
                  <BanIcon data-icon="inline-start" />
                  중단
                </Button>
              }
              title="이 발행을 중단할까요?"
              description="다른 플랫폼이 모두 끝나면 영상도 마무리돼요."
              action="중단"
              onConfirm={() =>
                ctrl.run(
                  { kind: 'publication', publicationId: p.id, name: 'cancel', body: guard },
                  '발행을 중단했어요',
                )
              }
            />
          </div>
        </div>
      )}
    </li>
  )
}

const titleOf = (v: Detail['video']) => `#${v.id} ${v.title || '(제목 없음)'}`

export function VideoDetailView({ data, heading = true }: { data: Detail; heading?: boolean }) {
  const { video, publications, post } = data
  const ctrl = useVideoController(data)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col items-start gap-2">
        {heading && (
          <h1 className="text-xl font-semibold tracking-tight break-words">{titleOf(video)}</h1>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <VideoStatusBadge status={video.status} />
          <VideoOriginBadge postId={video.post_id} />
          <span className="text-muted-foreground tabular-nums">
            {formatDuration(video.duration_ms)}
            {video.width && video.height ? ` · ${video.width}×${video.height}` : ''}
          </span>
        </div>
        {video.last_error && <p className="text-sm break-words text-destructive">{video.last_error}</p>}
      </div>

      <Player video={video} />

      <ActionsPanel ctrl={ctrl} />

      <Section
        title="내용"
        description={video.status === 'PENDING_REVIEW' ? '고치면 텔레그램 검수 메시지도 새로 와요' : undefined}
      >
        {video.status === 'PENDING_REVIEW' ? (
          // Re-mounted per revision so the form never keeps a stale draft.
          <MetaEditor key={video.revision} ctrl={ctrl} />
        ) : (
          <FieldList>
            <Field label="제목">{video.title || '-'}</Field>
          </FieldList>
        )}
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">발행되는 캡션</p>
          <pre className="rounded-lg border bg-muted/40 p-3 font-[inherit] text-sm break-words whitespace-pre-wrap">
            {video.full_caption || '-'}
          </pre>
          <div>
            <CopyButton text={video.full_caption} label="캡션 복사" />
          </div>
        </div>
      </Section>

      {video.scenes && (
        <Section title="원고">
          <ol className="flex flex-col gap-2 text-sm">
            {video.scenes.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: scenes are positional
              <li key={i}>
                <span className="font-medium">
                  [{i + 1}] {s.heading}
                </span>
                <p className="text-muted-foreground">{s.narration}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {publications.length > 0 && (
        <Section title="발행">
          <ul className="flex flex-col divide-y">
            {publications.map((p) => (
              <PublicationRow key={`${p.id}-${p.claim_seq}-${p.status}`} ctrl={ctrl} p={p} />
            ))}
          </ul>
        </Section>
      )}

      <Section title="정보">
        <FieldList>
          {post && (
            <Field label="원본 글">
              <Link to={`/posts/${post.id}`} className="underline-offset-4 hover:underline">
                #{post.id}
              </Link>
            </Field>
          )}
          {video.original_name && <Field label="올린 파일">{video.original_name}</Field>}
          <Field label="크기">{formatBytes(video.size_bytes)}</Field>
          <Field label="출처 링크">
            {isHttpUrl(video.source_url) ? (
              <a
                href={video.source_url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all underline-offset-4 hover:underline"
              >
                {video.source_url}
              </a>
            ) : (
              '-'
            )}
          </Field>
          <Field label="만든 시각">{when(video.created_at)}</Field>
          <Field label="발행">{when(video.published_at)}</Field>
        </FieldList>
      </Section>
    </div>
  )
}

function VideoDetailContainer({ id, heading }: { id: number; heading: boolean }) {
  const q = useVideo(id)
  return (
    <QueryBoundary query={q} skeleton={<DetailSkeleton />}>
      {(d) => <VideoDetailView data={d} heading={heading} />}
    </QueryBoundary>
  )
}

/** Direct navigation to /videos/:id: a full page. */
export function VideoDetailPage() {
  const id = parseId(useParams().id)
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/videos">
          <ArrowLeftIcon data-icon="inline-start" />
          목록
        </Link>
      </Button>
      {id ? (
        <VideoDetailContainer key={id} id={id} heading />
      ) : (
        <EmptyState title="잘못된 주소예요." icon={FilmIcon} />
      )}
    </>
  )
}

/** The same detail as a sheet over the list. */
export function VideoSheet() {
  const id = parseId(useParams().id)
  const navigate = useNavigate()
  const q = useVideo(id ?? 0)
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  return (
    <Sheet open onOpenChange={(open) => !open && navigate(-1)}>
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        onCloseAutoFocus={(e) => {
          if (opener?.isConnected) {
            e.preventDefault()
            opener.focus()
          }
        }}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8 leading-snug break-words">
            {q.data ? titleOf(q.data.video) : '영상 상세'}
          </SheetTitle>
          <SheetDescription>영상 상세</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {id ? (
            <VideoDetailContainer key={id} id={id} heading={false} />
          ) : (
            <EmptyState title="잘못된 주소예요." icon={FilmIcon} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
