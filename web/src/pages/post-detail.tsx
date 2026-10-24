import { ArrowLeftIcon, ExternalLinkIcon, MessageSquareTextIcon } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CopyButton } from '@/components/copy-button.tsx'
import { EmptyState, QueryBoundary } from '@/components/query-state.tsx'
import {
  OriginBadge,
  PartStatusBadge,
  PostStatusBadge,
  VerdictBadge,
} from '@/components/status-badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.tsx'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx'
import { charCount, formatDateTime, isHttpUrl, POST_REJECT_LABELS } from '@/lib/format.ts'
import { isPostWatchPending, type PostWatch, usePost } from '@/lib/queries.ts'
import type { PostDetailResponse } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'
import { DetailSkeleton, Field, FieldList, parseId, Section } from '@/pages/campaign-detail.tsx'
import {
  PartEditControls,
  PostActionsPanel,
  type PostController,
  usePostController,
} from '@/pages/post-actions.tsx'

type Detail = PostDetailResponse

const when = (iso: string | null) => <span className="tabular-nums">{formatDateTime(iso)}</span>

function ExternalLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!isHttpUrl(href)) return <span className="text-muted-foreground">-</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 break-all underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  )
}

/** `[2/3] 답글 2 · 123/500자`: one block per part, with status and the editor when under review. */
function PartBlock({
  label,
  text,
  limit,
  ctrl,
  idx,
  status,
  attempts,
  lastError,
  linkUrl,
  note,
}: {
  label: string
  text: string
  limit: number
  ctrl: PostController
  idx: number
  status?: string
  attempts?: number
  lastError?: string | null
  linkUrl?: string | null
  note?: ReactNode
}) {
  const count = charCount(text)
  const editable = ctrl.data.post.status === 'PENDING_REVIEW'
  return (
    <div className="flex flex-col gap-2" data-testid={`part-${idx}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span>
        <span className={cn('tabular-nums', count > limit && 'text-destructive')}>
          {count}/{limit}자
        </span>
        {status && <PartStatusBadge status={status} />}
        {attempts ? <span className="tabular-nums">시도 {attempts}회</span> : null}
      </div>
      <pre className="rounded-lg border bg-muted/40 p-3 font-[inherit] text-sm break-words whitespace-pre-wrap">
        {text}
      </pre>
      {note}
      {linkUrl && (
        <p className="text-xs text-muted-foreground">
          링크: <ExternalLink href={linkUrl}>{linkUrl}</ExternalLink>
        </p>
      )}
      {lastError && <p className="text-xs break-words text-destructive">{lastError}</p>}
      {editable && <PartEditControls ctrl={ctrl} idx={idx} text={text} />}
    </div>
  )
}

function PostBlocks({ ctrl }: { ctrl: PostController }) {
  const { post, parts, limits } = ctrl.data
  const total = parts.length + 1
  const chain = parts.length > 0
  const lastIdx = parts.at(-1)?.idx
  return (
    <div className="flex flex-col gap-4">
      <PartBlock
        ctrl={ctrl}
        idx={1}
        label={chain ? `[1/${total}] 본 글` : '본 글'}
        text={post.text}
        limit={limits.text}
      />
      {parts.map((p) => (
        <PartBlock
          key={`${p.idx}-${p.text}`}
          ctrl={ctrl}
          idx={p.idx}
          label={`[${p.idx}/${total}] 답글 ${p.idx}`}
          text={p.text}
          limit={p.idx === lastIdx ? limits.lastFollowup : limits.text}
          status={post.status === 'PENDING_REVIEW' ? undefined : p.status}
          attempts={p.attempts}
          lastError={p.last_error}
          linkUrl={p.link_url}
          note={
            p.idx === lastIdx && limits.cta ? (
              <p className="text-xs text-muted-foreground">
                발행할 때 이 답글 끝에 문구가 붙어요: {limits.cta}
              </p>
            ) : undefined
          }
        />
      ))}
      <div>
        <CopyButton
          text={[post.text, ...parts.map((p) => p.text)].join('\n\n')}
          label="전체 복사"
        />
      </div>
    </div>
  )
}

function ReviveInfo({ post }: { post: Detail['post'] }) {
  const r = post.revive
  if (!r.verdict && !r.revived_at) return null
  return (
    <Section title="재활용" description="만료된 초안의 판정과 살린 기록">
      <FieldList>
        <Field label="판정">
          <VerdictBadge verdict={r.verdict} />
        </Field>
        <Field label="판정 이유">{r.reason || '-'}</Field>
        <Field label="판정 시각">{when(r.checked_at)}</Field>
        <Field label="살린 시각">{when(r.revived_at)}</Field>
      </FieldList>
      {r.from_text && (
        <Collapsible className="mt-3">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              살리기 전 원문 보기
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 rounded-lg border bg-muted/40 p-3 font-[inherit] text-sm break-words whitespace-pre-wrap">
              {r.from_text}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Section>
  )
}

const titleOf = (post: Detail['post']) => `#${post.id} ${post.topic.title || '(제목 없음)'}`

export function PostDetailView({
  data,
  watch = null,
  onWatch = () => {},
  now,
  heading = true,
}: {
  data: Detail
  watch?: PostWatch | null
  onWatch?: (watch: PostWatch) => void
  now?: Date
  /** false when the surrounding sheet already shows the title. */
  heading?: boolean
}) {
  const { post } = data
  const ctrl = usePostController(data, watch, onWatch, now)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col items-start gap-2">
        {heading && (
          <h1 className="text-xl font-semibold tracking-tight break-words">{titleOf(post)}</h1>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <PostStatusBadge status={post.status} />
          <OriginBadge origin={post.origin} />
        </div>
        <div className="flex flex-wrap gap-2">
          {isHttpUrl(post.source_url) && (
            <Button asChild size="sm" variant="outline">
              <a href={post.source_url} target="_blank" rel="noreferrer noopener">
                원문 열기
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          )}
        </div>
      </div>

      <PostActionsPanel ctrl={ctrl} />

      <Section
        title="글"
        description={
          post.status === 'PENDING_REVIEW' ? '수정하면 그대로 바뀌어요 (텔레그램 수정 답장과 같아요)' : undefined
        }
      >
        {/* Re-mounted per revision so an editor never keeps a stale draft. */}
        <PostBlocks key={post.revision} ctrl={ctrl} />
      </Section>

      <Section title="정보">
        <FieldList>
          <Field label="주제">{post.topic.title || '-'}</Field>
          <Field label="주제 링크">
            <ExternalLink href={post.topic.url}>{post.topic.url ?? '-'}</ExternalLink>
          </Field>
          <Field label="출처 링크">
            <ExternalLink href={post.source_url}>{post.source_url ?? '-'}</ExternalLink>
          </Field>
          <Field label="앵글">{post.angle || '-'}</Field>
          {post.topic.note && <Field label="내 의견">{post.topic.note}</Field>}
          <Field label="확인 필요">
            {post.caveats.length ? (
              <ul className="list-disc pl-4">
                {post.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              '-'
            )}
          </Field>
          <Field label="예약">{when(post.scheduled_at)}</Field>
          <Field label="발행">{when(post.published_at)}</Field>
          {post.reject_reason && (
            <Field label="폐기 사유">
              {POST_REJECT_LABELS[post.reject_reason] ?? post.reject_reason}
            </Field>
          )}
          {(post.attempts > 0 || post.last_error) && (
            <Field label="발행 시도">
              <span className="tabular-nums">{post.attempts}회</span>
              {post.last_error && (
                <span className="block text-xs break-words text-destructive">
                  {post.last_error}
                </span>
              )}
            </Field>
          )}
          {post.digest_post_id !== null && (
            <Field label="묶음 글">
              <Link
                to={`/posts/${post.digest_post_id}`}
                className="underline-offset-4 hover:underline"
              >
                #{post.digest_post_id}
              </Link>
            </Field>
          )}
          <Field label="생성">{when(post.created_at)}</Field>
          <Field label="갱신">{when(post.updated_at)}</Field>
        </FieldList>
      </Section>

      <ReviveInfo post={post} />
    </div>
  )
}

/**
 * The post, its actions and the pending-job watch: after a regeneration or revival is queued the
 * post is re-read every few seconds until its revision (or status) changes.
 */
function PostDetailContainer({ id, heading }: { id: number; heading: boolean }) {
  const [watch, setWatch] = useState<PostWatch | null>(null)
  const q = usePost(id, watch !== null)
  const data = q.data
  // The queued job is done once the post differs from what the request started from.
  useEffect(() => {
    if (watch && data && !isPostWatchPending(watch, data.post)) setWatch(null)
  }, [watch, data])
  return (
    <QueryBoundary query={q} skeleton={<DetailSkeleton />}>
      {(d) => <PostDetailView data={d} watch={watch} onWatch={setWatch} heading={heading} />}
    </QueryBoundary>
  )
}

/** Direct navigation to /posts/:id: a full page. */
export function PostDetailPage() {
  const id = parseId(useParams().id)
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/posts">
          <ArrowLeftIcon data-icon="inline-start" />
          목록
        </Link>
      </Button>
      {id ? (
        <PostDetailContainer key={id} id={id} heading />
      ) : (
        <EmptyState title="잘못된 주소예요." icon={MessageSquareTextIcon} />
      )}
    </>
  )
}

/** The same detail as a sheet over the list (opened from a row, history keeps the list behind). */
export function PostSheet() {
  const id = parseId(useParams().id)
  const navigate = useNavigate()
  const title = useSheetTitle(id)
  // The sheet is a route without a Radix trigger, so Radix cannot give focus back on close.
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
          <SheetTitle className="pr-8 leading-snug break-words">{title}</SheetTitle>
          <SheetDescription>Threads 글 상세</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {id ? (
            <PostDetailContainer key={id} id={id} heading={false} />
          ) : (
            <EmptyState title="잘못된 주소예요." icon={MessageSquareTextIcon} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** The sheet title comes from the same cached query the body uses. */
function useSheetTitle(id: number | null) {
  const q = usePost(id ?? 0)
  return q.data ? titleOf(q.data.post) : '글 상세'
}
