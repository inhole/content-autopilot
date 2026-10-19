import { Badge } from '@/components/ui/badge.tsx'
import {
  daysUntil,
  formatDday,
  ORIGIN_LABELS,
  postStatusLabel,
  sourceLabel,
  statusLabel,
} from '@/lib/format.ts'
import { campaignTone, deadlineTone, postTone } from '@/lib/status.ts'
import type { CampaignRow, PostItem } from '@/lib/types.ts'
import { cn } from '@/lib/utils.ts'

export const CampaignStatusBadge = ({ status }: { status: string }) => (
  <Badge variant={campaignTone(status)}>{statusLabel(status)}</Badge>
)

export const PostStatusBadge = ({ status }: { status: string }) => (
  <Badge variant={postTone(status)}>{postStatusLabel(status)}</Badge>
)

export const OriginBadge = ({ origin }: { origin: PostItem['origin'] }) =>
  ORIGIN_LABELS[origin] ? <Badge variant="outline">{ORIGIN_LABELS[origin]}</Badge> : null

/** A small dot that tells the sources apart without spending a colour on the whole row. */
export function SourceDot({ source, className }: { source: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        source === 'musinsa' ? 'bg-foreground' : 'bg-chart-3',
        className,
      )}
    />
  )
}

export function SourceLabel({ source }: { source: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <SourceDot source={source} />
      {sourceLabel(source)}
    </span>
  )
}

/** `D-3` (emphasised when 2 days or less), plus `추정` only when the API marks it as estimated. */
export function DeadlineBadge({ row, now }: { row: CampaignRow; now?: Date }) {
  const d = row.next_deadline
  if (!d) return <span className="text-muted-foreground">-</span>
  const days = daysUntil(d.at, now)
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={deadlineTone(days)} className="tabular-nums">
        {formatDday(days)}
      </Badge>
      {d.estimated && <span className="text-xs text-muted-foreground">추정</span>}
    </span>
  )
}
