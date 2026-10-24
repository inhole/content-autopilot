import { ArchiveRestoreIcon, CheckIcon, GavelIcon, NewspaperIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { EmptyState, ListSkeleton, PageHeader, QueryBoundary } from '@/components/query-state.tsx'
import { VerdictBadge } from '@/components/status-badge.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { formatAge, formatShortDateTime, truncate } from '@/lib/format.ts'
import { useDigest, useReviveCheck, useRevivable } from '@/lib/queries.ts'
import type { RevivableRow } from '@/lib/types.ts'
import { Confirm, ReviveRowButton } from '@/pages/post-actions.tsx'

type Notice = { kind: 'ok' | 'error'; text: string }

/** How long the list is re-read faster after a judgement was requested. */
const CHECK_POLL_MS = 3 * 60_000

export function RevivableList({
  rows,
  onQueued,
  onError,
  now,
}: {
  rows: RevivableRow[]
  onQueued: (telegramSynced: boolean) => void
  onError: (message: string) => void
  now?: Date
}) {
  const location = useLocation()
  if (rows.length === 0) {
    return (
      <EmptyState
        title="살릴 수 있는 만료 초안이 없어요."
        description="최근 30일 안에 만료된 뉴스 초안이 여기에 나타나요."
        icon={ArchiveRestoreIcon}
      />
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <VerdictBadge verdict={r.verdict} />
            <span className="tabular-nums">
              {formatShortDateTime(r.created_at)} · {formatAge(r.created_at, now)}
            </span>
            {r.checked_at && <span className="tabular-nums">판정 {formatShortDateTime(r.checked_at)}</span>}
          </div>
          <Link
            to={`/posts/${r.id}`}
            state={{ background: location }}
            className="font-medium break-words underline-offset-4 hover:underline"
          >
            #{r.id} {r.title}
          </Link>
          <p className="break-words text-muted-foreground">{truncate(r.text, 120)}</p>
          {r.reason && <p className="text-xs break-words">판정 이유: {r.reason}</p>}
          <div>
            <ReviveRowButton id={r.id} title={r.title} onQueued={onQueued} onError={onError} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ExpiredPage() {
  const [pollUntil, setPollUntil] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const q = useRevivable(pollUntil)
  const check = useReviveCheck()
  const digest = useDigest()
  const judging = Date.now() < pollUntil

  const say = (kind: Notice['kind'], text: string) => setNotice({ kind, text })

  return (
    <>
      <PageHeader
        title="만료 초안"
        description="48시간 안에 검수하지 못해 만료된 뉴스 초안 · 최근 30일"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={check.isPending}
            onClick={() => {
              setNotice(null)
              check.mutate(undefined, {
                onSuccess: () => {
                  setPollUntil(Date.now() + CHECK_POLL_MS)
                  say(
                    'ok',
                    '판정을 요청했어요. 결과는 텔레그램으로 오고, 이 목록의 판정도 끝나는 대로 바뀌어요.',
                  )
                },
                onError: (e) => say('error', e.message),
              })
            }}
          >
            {check.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <GavelIcon data-icon="inline-start" />
            )}
            판정 요청
          </Button>
          <Confirm
            trigger={
              <Button type="button" size="sm" variant="outline" disabled={digest.isPending}>
                <NewspaperIcon data-icon="inline-start" />
                주간 묶음 지금 만들기
              </Button>
            }
            title="주간 묶음을 지금 만들까요?"
            description="시의성이 지난 만료 초안을 최대 3개까지 하나의 연결 글로 묶어 검수 대기로 보내요. 보통은 일요일 18시에 자동으로 만들어요."
            action="만들기"
            onConfirm={() =>
              digest.mutate(undefined, {
                onSuccess: () =>
                  say('ok', '묶음을 만들고 있어요. 끝나면 텔레그램으로 검수 요청이 와요.'),
                onError: (e) => say('error', e.message),
              })
            }
          />
        </div>
      </PageHeader>

      {notice && (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'}>
          {notice.kind === 'error' ? <TriangleAlertIcon /> : <CheckIcon />}
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      {judging && !notice && (
        <Alert role="status">
          <Spinner />
          <AlertDescription>판정 결과를 기다리고 있어요.</AlertDescription>
        </Alert>
      )}

      <QueryBoundary query={q} skeleton={<ListSkeleton rows={4} />}>
        {(data) => (
          <RevivableList
            rows={data.rows}
            onQueued={(synced) =>
              say(
                'ok',
                synced
                  ? '살리는 중이에요. 끝나면 검수 대기로 올라가고 텔레그램에도 와요.'
                  : '살리는 중이에요. 텔레그램 메시지는 갱신하지 못했어요.',
              )
            }
            onError={(m) => say('error', m)}
          />
        )}
      </QueryBoundary>
    </>
  )
}
