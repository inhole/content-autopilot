import { CheckIcon, MessageSquareTextIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { OriginBadge, PostStatusBadge } from '@/components/status-badge.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ApiError } from '@/lib/api.ts'
import { formatNumber, formatShortDateTime, isHttpUrl, truncate } from '@/lib/format.ts'
import { useAddTopic, usePosts } from '@/lib/queries.ts'
import type { PostItem } from '@/lib/types.ts'

const num = 'text-right tabular-nums'

/** Link to the post that opens as a sheet over the list. */
export function usePostLink() {
  const location = useLocation()
  return (id: number) => ({
    to: `/posts/${id}`,
    state: { background: location },
  })
}

function PostLink({ post, className }: { post: PostItem; className?: string }) {
  const link = usePostLink()(post.id)
  return (
    <Link {...link} className={className} title={post.text}>
      {truncate(post.text, 80)}
    </Link>
  )
}

export function PostsTable({ rows }: { rows: PostItem[] }) {
  const navigate = useNavigate()
  const postLink = usePostLink()
  if (rows.length === 0) {
    return <EmptyState title="글이 아직 없어요." icon={MessageSquareTextIcon} />
  }
  const openRow = (p: PostItem, target: EventTarget) => {
    if (target instanceof Element && target.closest('a, button')) return
    const l = postLink(p.id)
    navigate(l.to, { state: l.state })
  }
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>상태</TableHead>
              <TableHead>예약</TableHead>
              <TableHead>발행</TableHead>
              <TableHead>내용</TableHead>
              <TableHead className="text-right">조회</TableHead>
              <TableHead className="text-right">좋아요</TableHead>
              <TableHead className="text-right">답글</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id} className="cursor-pointer" onClick={(e) => openRow(p, e.target)}>
                <TableCell>
                  <PostStatusBadge status={p.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatShortDateTime(p.scheduled_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatShortDateTime(p.published_at)}
                </TableCell>
                <TableCell className="max-w-sm">
                  <div className="flex items-center gap-2">
                    <OriginBadge origin={p.origin} />
                    <PostLink
                      post={p}
                      className="min-w-0 truncate underline-offset-4 hover:underline"
                    />
                  </div>
                </TableCell>
                <TableCell className={num}>{formatNumber(p.views)}</TableCell>
                <TableCell className={num}>{formatNumber(p.likes)}</TableCell>
                <TableCell className={num}>{formatNumber(p.replies)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <PostStatusBadge status={p.status} />
              <OriginBadge origin={p.origin} />
              <span className="tabular-nums">예약 {formatShortDateTime(p.scheduled_at)}</span>
              <span className="tabular-nums">발행 {formatShortDateTime(p.published_at)}</span>
            </div>
            <PostLink post={p} className="break-words underline-offset-4 hover:underline" />
            <p className="text-xs text-muted-foreground tabular-nums">
              조회 {formatNumber(p.views)} · 좋아요 {formatNumber(p.likes)} · 답글{' '}
              {formatNumber(p.replies)}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}

function PostsSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border" role="status" aria-label="불러오는 중">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none border-b" />
      ))}
    </div>
  )
}

/** "URL로 초안 만들기": a manual topic from a link, like Telegram `/add <url> [note]`. */
export function AddTopicDialog() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const add = useAddTopic()
  const valid = isHttpUrl(url.trim())

  const reset = () => {
    setUrl('')
    setNote('')
    add.reset()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid || add.isPending) return
    const text = note.trim()
    add.mutate({ url: url.trim(), ...(text ? { note: text } : {}) })
  }
  const conflict =
    add.error instanceof ApiError && add.error.status === 409 ? add.error : null
  const coveredId = conflict && typeof conflict.body.postId === 'number' ? conflict.body.postId : null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <PlusIcon data-icon="inline-start" />
          URL로 초안 만들기
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>URL로 초안 만들기</DialogTitle>
          <DialogDescription>
            기사 주소를 넣으면 원문을 읽고 초안을 써요. 텔레그램 /add 와 같아요.
          </DialogDescription>
        </DialogHeader>

        {add.isSuccess ? (
          <>
            <Alert role="status">
              <CheckIcon />
              <AlertDescription>
                초안을 쓰고 있어요. 다 쓰면 텔레그램으로 오고, 이 목록에도 검수 대기로 나타나요.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                닫기
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="add-url">기사 URL</FieldLabel>
                <Input
                  id="add-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                  autoComplete="off"
                  inputMode="url"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="add-note">한 줄 의견 (선택)</FieldLabel>
                <Textarea
                  id="add-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                />
                <FieldDescription>글의 각도로만 쓰고, 사실의 근거로는 쓰지 않아요.</FieldDescription>
              </Field>
            </FieldGroup>

            {add.isError && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertDescription>
                  {conflict ? (
                    <span>
                      이미 다룬 기사예요.{' '}
                      {coveredId !== null && (
                        <Link
                          to={`/posts/${coveredId}`}
                          className="underline underline-offset-4"
                          onClick={() => setOpen(false)}
                        >
                          글 #{coveredId} 보기
                        </Link>
                      )}
                    </span>
                  ) : (
                    add.error.message
                  )}
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="submit" disabled={!valid || add.isPending}>
                {add.isPending && <Spinner data-icon="inline-start" />}
                초안 만들기
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PostsPage() {
  const q = usePosts()
  return (
    <>
      <PageHeader
        title="Threads 글"
        description="최근 글 50개 · 반응은 가장 최근에 수집한 값 · 시각은 한국 시간"
      >
        <AddTopicDialog />
      </PageHeader>
      <QueryBoundary query={q} skeleton={<PostsSkeleton />}>
        {(data) => <PostsTable rows={data.rows} />}
      </QueryBoundary>
    </>
  )
}
