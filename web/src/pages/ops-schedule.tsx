import { PencilIcon, PlusIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Toggle } from '@/components/ui/toggle.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeDaily, humanizeCron } from '@/lib/ops.ts'
import { useResetSchedule, useSaveSchedule } from '@/lib/queries.ts'
import type {
  OpsCronView,
  OpsSchedule,
  OpsScheduleFields,
  OpsScheduleView,
} from '@/lib/types.ts'
import { Confirm } from '@/pages/post-actions.tsx'

type NoticeFn = (kind: 'ok' | 'error', text: string) => void

// Mirrors the limits in src/web/api-types.ts (the server stays authoritative).
const MAX_SLOTS = 10
const SLOT = /^([01]\d|2[0-3]):[0-5]\d$/

export const COLLECTS = [
  { key: 'threadsCollect', label: 'Threads 뉴스 수집' },
  { key: 'giftCollect', label: '카카오톡 선물하기 수집' },
  { key: 'musinsaCollect', label: '무신사 수집' },
] as const
type CollectKey = (typeof COLLECTS)[number]['key']

type CollectForm = { hours: number[]; minute: string }
type SlotRow = { id: number; value: string }
export type ScheduleFormState = {
  collects: Record<CollectKey, CollectForm>
  dailyPostCount: string
  campaignDailyMax: string
  slots: SlotRow[]
}
type Errors = Record<string, string>

let nextSlotId = 1
const slotRows = (slots: string[]): SlotRow[] =>
  slots.map((value) => ({ id: nextSlotId++, value }))

/** Where an editor starts for a collect: its simple form, else the default's, else empty. */
const startOf = (cur: OpsCronView, def: OpsCronView): CollectForm => {
  const d = cur.daily ?? def.daily
  return d ? { hours: [...d.hours], minute: String(d.minute) } : { hours: [], minute: '0' }
}

export const toScheduleForm = (s: OpsSchedule): ScheduleFormState => ({
  collects: {
    threadsCollect: startOf(s.current.threadsCollect, s.defaults.threadsCollect),
    giftCollect: startOf(s.current.giftCollect, s.defaults.giftCollect),
    musinsaCollect: startOf(s.current.musinsaCollect, s.defaults.musinsaCollect),
  },
  dailyPostCount: String(s.current.dailyPostCount),
  campaignDailyMax: String(s.current.campaignDailyMax),
  slots: slotRows(s.current.publishSlots),
})

const intOf = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v))

/** The distinct valid `HH:MM` values, sorted. */
const cleanSlots = (rows: SlotRow[]): string[] =>
  [...new Set(rows.map((r) => r.value).filter((v) => SLOT.test(v)))].sort()

/** Form -> request body, or the problems per field. Errors are keyed by dotted field path. */
export function buildSchedule(
  f: ScheduleFormState,
): { ok: true; schedule: OpsScheduleFields } | { ok: false; errors: Errors } {
  const errors: Errors = {}
  const daily = {} as Record<CollectKey, { minute: number; hours: number[] }>
  for (const { key } of COLLECTS) {
    const c = f.collects[key]
    const minute = intOf(c.minute)
    if (!Number.isInteger(minute) || minute < 0 || minute > 59)
      errors[`${key}.minute`] = '0~59 사이의 정수로 넣어 주세요'
    if (c.hours.length === 0) errors[`${key}.hours`] = '시각을 하나 이상 골라 주세요'
    daily[key] = { minute, hours: [...new Set(c.hours)].sort((a, b) => a - b) }
  }
  const dailyPostCount = intOf(f.dailyPostCount)
  if (!Number.isInteger(dailyPostCount) || dailyPostCount < 1 || dailyPostCount > 10)
    errors.dailyPostCount = '1~10 사이의 정수로 넣어 주세요'
  const campaignDailyMax = intOf(f.campaignDailyMax)
  if (!Number.isInteger(campaignDailyMax) || campaignDailyMax < 1 || campaignDailyMax > 20)
    errors.campaignDailyMax = '1~20 사이의 정수로 넣어 주세요'
  if (f.slots.length === 0) errors.publishSlots = '발행 시각을 하나 이상 넣어 주세요'
  if (f.slots.length > MAX_SLOTS) errors.publishSlots = `발행 시각은 ${MAX_SLOTS}개까지예요`
  for (const r of f.slots)
    if (!SLOT.test(r.value)) errors[`slot:${r.id}`] = '시각을 넣어 주세요 (예: 09:00)'

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    schedule: {
      threadsCollect: daily.threadsCollect,
      giftCollect: daily.giftCollect,
      musinsaCollect: daily.musinsaCollect,
      dailyPostCount,
      publishSlots: cleanSlots(f.slots),
      campaignDailyMax,
    },
  }
}

function Item({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)

export function ScheduleForm({
  schedule,
  onCancel,
  onSaved,
  onError,
}: {
  schedule: OpsSchedule
  onCancel: () => void
  onSaved: (applied: boolean) => void
  onError: (message: string) => void
}) {
  const id = useId()
  const [form, setForm] = useState<ScheduleFormState>(() => toScheduleForm(schedule))
  // The revision the form was filled from: polling may bring a newer copy while editing, and
  // saving these values on that newer revision would overwrite it instead of answering 409.
  const [revision] = useState(schedule.revision)
  // Collects whose current cron is not a simple daily one: saving replaces it.
  const [replaced] = useState(() =>
    COLLECTS.filter(({ key }) => schedule.current[key].daily === null).map(({ key }) => key),
  )
  const [errors, setErrors] = useState<Errors>({})
  const save = useSaveSchedule()
  const pending = save.isPending

  const setCollect = (key: CollectKey, patch: Partial<CollectForm>) =>
    setForm((f) => ({ ...f, collects: { ...f.collects, [key]: { ...f.collects[key], ...patch } } }))
  const toggleHour = (key: CollectKey, h: number, on: boolean) =>
    setCollect(key, {
      hours: on
        ? [...form.collects[key].hours, h].sort((a, b) => a - b)
        : form.collects[key].hours.filter((x) => x !== h),
    })
  const setSlot = (rowId: number, value: string) =>
    setForm((f) => ({ ...f, slots: f.slots.map((r) => (r.id === rowId ? { ...r, value } : r)) }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const built = buildSchedule(form)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    save.mutate(
      { revision, schedule: built.schedule },
      {
        onSuccess: (res) => onSaved(res.applied),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 400 && Array.isArray(err.body.fields)) {
            const next: Errors = {}
            for (const p of err.body.fields as string[]) {
              const m = p.match(/^publishSlots\.(\d+)$/)
              if (m) {
                // The index refers to the list we sent (sorted, deduplicated).
                const value = built.schedule.publishSlots[Number(m[1])]
                const rows = form.slots.filter((r) => r.value === value)
                for (const r of rows) next[`slot:${r.id}`] = err.message
                if (rows.length === 0) next.publishSlots = err.message
              } else next[p] = err.message
            }
            setErrors(next)
            return
          }
          if (err instanceof ApiError && err.status === 409) {
            onError(
              '다른 곳에서 먼저 바뀌었어요. 최신 내용을 다시 불러왔으니 확인하고 다시 수정해 주세요.',
            )
            onCancel()
            return
          }
          onError(err.message)
        },
      },
    )
  }

  const postCount = intOf(form.dailyPostCount)
  const slotCount = cleanSlots(form.slots).length
  const fewSlots = Number.isInteger(postCount) && slotCount > 0 && slotCount < postCount

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {COLLECTS.map(({ key, label }) => {
        const c = form.collects[key]
        const minute = intOf(c.minute)
        return (
          <fieldset
            key={key}
            className="flex min-w-0 flex-col gap-2"
            aria-label={label}
            data-testid={`sched-${key}`}
          >
            <legend className="text-sm font-medium">{label}</legend>
            <div
              role="group"
              aria-label={`${label} 시각`}
              className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-12"
            >
              {HOURS.map((h) => (
                <Toggle
                  key={h}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`${label} ${h}시`}
                  pressed={c.hours.includes(h)}
                  disabled={pending}
                  onPressedChange={(on) => toggleHour(key, h, on)}
                  className="tabular-nums data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                >
                  {h}
                </Toggle>
              ))}
            </div>
            {errors[`${key}.hours`] && (
              <p className="text-sm text-destructive">{errors[`${key}.hours`]}</p>
            )}
            <Item
              label={`${label} 분`}
              error={errors[`${key}.minute`]}
              htmlFor={`${id}-${key}-minute`}
            >
              <Input
                id={`${id}-${key}-minute`}
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                className="w-24"
                value={c.minute}
                aria-invalid={!!errors[`${key}.minute`]}
                disabled={pending}
                onChange={(e) => setCollect(key, { minute: e.target.value })}
              />
            </Item>
            <p className="text-sm text-muted-foreground" data-testid={`sched-summary-${key}`}>
              {describeDaily(Number.isInteger(minute) ? minute : null, c.hours)}
            </p>
            {replaced.includes(key) && (
              <p className="text-xs text-muted-foreground">
                지금 일정({schedule.current[key].cron})은 단순한 형태가 아니에요. 저장하면 여기서 고른
                일정으로 바뀌어요.
              </p>
            )}
          </fieldset>
        )
      })}

      <div className="grid gap-4 sm:grid-cols-2">
        <Item
          label="하루 초안 수"
          hint="1~10개. 다음 Threads 수집부터 적용돼요"
          error={errors.dailyPostCount}
          htmlFor={`${id}-posts`}
        >
          <Input
            id={`${id}-posts`}
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            value={form.dailyPostCount}
            aria-invalid={!!errors.dailyPostCount}
            disabled={pending}
            onChange={(e) => setForm((f) => ({ ...f, dailyPostCount: e.target.value }))}
          />
        </Item>
        <Item
          label="체험단 하루 카드 수 (출처별)"
          hint="1~20개. 다음 선별부터 적용돼요"
          error={errors.campaignDailyMax}
          htmlFor={`${id}-camp`}
        >
          <Input
            id={`${id}-camp`}
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            value={form.campaignDailyMax}
            aria-invalid={!!errors.campaignDailyMax}
            disabled={pending}
            onChange={(e) => setForm((f) => ({ ...f, campaignDailyMax: e.target.value }))}
          />
        </Item>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2" aria-label="발행 시각">
        <legend className="text-sm font-medium">발행 시각 ({slotCount}개)</legend>
        <p className="text-xs text-muted-foreground">
          승인한 글이 이 시각에 하나씩 나가요. 저장하면 정렬하고 겹치는 시각은 하나로 합쳐요. 이미
          예약된 글의 시각은 그대로예요.
        </p>
        {form.slots.map((r, i) => (
          <div key={r.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                type="time"
                aria-label={`발행 시각 ${i + 1}`}
                className="w-36"
                value={r.value}
                aria-invalid={!!errors[`slot:${r.id}`]}
                disabled={pending}
                onChange={(e) => setSlot(r.id, e.target.value)}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`발행 시각 ${i + 1} 삭제`}
                disabled={pending || form.slots.length <= 1}
                onClick={() =>
                  setForm((f) => ({ ...f, slots: f.slots.filter((x) => x.id !== r.id) }))
                }
              >
                <Trash2Icon />
              </Button>
            </div>
            {errors[`slot:${r.id}`] && (
              <p className="text-sm text-destructive">{errors[`slot:${r.id}`]}</p>
            )}
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || form.slots.length >= MAX_SLOTS}
            onClick={() => setForm((f) => ({ ...f, slots: [...f.slots, ...slotRows(['12:00'])] }))}
          >
            <PlusIcon data-icon="inline-start" />
            시각 추가
          </Button>
        </div>
        {errors.publishSlots && <p className="text-sm text-destructive">{errors.publishSlots}</p>}
        {fewSlots && (
          <p className="text-sm text-muted-foreground" data-testid="slots-hint">
            발행 시각({slotCount}개)이 하루 초안 수({postCount}개)보다 적어요. 남는 글은 다음 날
            시각으로 넘어가요.
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          저장
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          취소
        </Button>
      </div>
    </form>
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function Default({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null
  return <span className="block text-xs text-muted-foreground">기본값: {children}</span>
}

const SHORT: Record<CollectKey, string> = {
  threadsCollect: 'Threads 수집',
  giftCollect: '선물하기 수집',
  musinsaCollect: '무신사 수집',
}

function ScheduleRows({ cur, def }: { cur: OpsScheduleView; def: OpsScheduleView }) {
  return (
    <dl className="flex flex-col gap-3 text-sm">
      {COLLECTS.map(({ key }) => (
        <Row key={key} label={SHORT[key]}>
          {humanizeCron(cur[key].cron)}
          <Default show={cur[key].cron !== def[key].cron}>{humanizeCron(def[key].cron)}</Default>
        </Row>
      ))}
      <Row label="하루 초안 수">
        {cur.dailyPostCount}개
        <Default show={cur.dailyPostCount !== def.dailyPostCount}>{def.dailyPostCount}개</Default>
      </Row>
      <Row label="발행 시각">
        {cur.publishSlots.join(' · ')}
        <Default show={!same(cur.publishSlots, def.publishSlots)}>
          {def.publishSlots.join(' · ')}
        </Default>
      </Row>
      <Row label="체험단 하루 최대">
        출처별 {cur.campaignDailyMax}개
        <Default show={cur.campaignDailyMax !== def.campaignDailyMax}>
          출처별 {def.campaignDailyMax}개
        </Default>
      </Row>
    </dl>
  )
}

export function ScheduleCard({
  schedule,
  onNotice,
}: {
  schedule: OpsSchedule
  onNotice?: NoticeFn
}) {
  const [editing, setEditing] = useState(false)
  const reset = useResetSchedule()
  const say: NoticeFn = (kind, text) => onNotice?.(kind, text)
  // The revision shown when the confirmation opened: polling may bring a newer copy while it is
  // open, and resetting on that one would discard it instead of answering 409.
  const resetRevision = useRef(0)
  const doReset = () => {
    reset.mutate(
      { revision: resetRevision.current },
      {
        onSuccess: (res) =>
          say(
            res.applied ? 'ok' : 'error',
            res.applied
              ? '기본값(환경변수)으로 되돌렸어요.'
              : '기본값으로 되돌렸지만 일정을 바로 적용하지 못했어요. 워커를 다시 시작하면 적용돼요.',
          ),
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
    <Card data-testid="schedule-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          일정과 수량
          <Badge variant={schedule.source === 'db' ? 'info' : 'outline'}>
            {schedule.source === 'db' ? '페이지에서 수정함' : '기본값(환경변수)'}
          </Badge>
        </CardTitle>
        <CardDescription>
          수집 일정은 저장하는 즉시 바뀌어요. 초안 수는 다음 Threads 수집부터, 발행 시각은 다음
          승인부터, 체험단 카드 수는 다음 선별부터 적용돼요. 시각은 한국 시간이에요.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {editing ? (
          <ScheduleForm
            schedule={schedule}
            onCancel={() => setEditing(false)}
            onSaved={(applied) => {
              setEditing(false)
              if (applied) say('ok', '일정과 수량을 저장했어요.')
              else
                say(
                  'error',
                  '저장은 했지만 일정을 바로 적용하지 못했어요. 워커를 다시 시작하면 적용돼요.',
                )
            }}
            onError={(m) => say('error', m)}
          />
        ) : (
          <>
            <ScheduleRows cur={schedule.current} def={schedule.defaults} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon data-icon="inline-start" />
                편집
              </Button>
              {schedule.source === 'db' && (
                <Confirm
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={reset.isPending}
                      onClick={() => {
                        resetRevision.current = schedule.revision
                      }}
                    >
                      {reset.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <RotateCcwIcon data-icon="inline-start" />
                      )}
                      기본값으로 되돌리기
                    </Button>
                  }
                  title="기본값으로 되돌릴까요?"
                  description="페이지에서 고친 일정과 수량이 사라지고 환경 변수 값이 다시 쓰여요. 수집 일정은 바로 바뀌어요."
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
