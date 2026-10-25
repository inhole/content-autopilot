import { SaveIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ApiError } from '@/lib/api.ts'
import { useSaveProfile } from '@/lib/queries.ts'
import type { OpsProfile, OpsProfileFields } from '@/lib/types.ts'
import { SHEET_ACTIONS_CLASS } from '@/pages/ops-edit-sheet.tsx'

// Mirrors the limits in src/web/api-types.ts (the server stays authoritative).
const LIST_MAX_ITEMS = 50
const LIST_MAX_CHARS = 50
/** Characters as the server counts them (code points, so an emoji is one). */
const chars = (s: string) => [...s].length

export type FormState = {
  about: string
  interests: string
  preferKeywords: string
  excludeKeywords: string
  excludeBrands: string
  maxCompetition: string
  minPriceWon: string
  tone: string
  minChars: string
  maxChars: string
  points: string
  disclosure: string
}

/** One item per line; trimmed, empty lines dropped, duplicates removed. */
export const parseList = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((i) => i.trim())
      .filter(Boolean),
  ),
]

export const toForm = (p: OpsProfileFields): FormState => ({
  about: p.about,
  interests: p.interests.join('\n'),
  preferKeywords: p.preferKeywords.join('\n'),
  excludeKeywords: p.excludeKeywords.join('\n'),
  excludeBrands: p.excludeBrands.join('\n'),
  maxCompetition: p.maxCompetition == null ? '' : String(p.maxCompetition),
  minPriceWon: p.minPriceWon == null ? '' : String(p.minPriceWon),
  tone: p.review.tone,
  minChars: String(p.review.minChars),
  maxChars: String(p.review.maxChars),
  points: p.review.points.join('\n'),
  disclosure: p.disclosure ?? '',
})

type Key =
  | 'about'
  | 'interests'
  | 'preferKeywords'
  | 'excludeKeywords'
  | 'excludeBrands'
  | 'maxCompetition'
  | 'minPriceWon'
  | 'review.tone'
  | 'review.minChars'
  | 'review.maxChars'
  | 'review.points'
  | 'disclosure'
type Errors = Partial<Record<Key, string>>

const num = (v: string): number | null => {
  const t = v.trim()
  return t === '' ? null : Number(t)
}

/** Form text -> request body, or the problems per field. */
export function buildProfile(
  f: FormState,
): { ok: true; profile: OpsProfileFields } | { ok: false; errors: Errors } {
  const errors: Errors = {}
  const lists = {
    interests: parseList(f.interests),
    preferKeywords: parseList(f.preferKeywords),
    excludeKeywords: parseList(f.excludeKeywords),
    excludeBrands: parseList(f.excludeBrands),
    'review.points': parseList(f.points),
  } as const
  for (const [key, items] of Object.entries(lists)) {
    if (items.length > LIST_MAX_ITEMS) errors[key as Key] = `항목은 ${LIST_MAX_ITEMS}개까지예요`
    else if (items.some((i) => chars(i) > LIST_MAX_CHARS))
      errors[key as Key] = `항목 하나는 ${LIST_MAX_CHARS}자까지예요`
  }
  const about = f.about.trim()
  if (chars(about) > 500) errors.about = '소개는 500자까지예요'
  const tone = f.tone.trim()
  if (chars(tone) > 200) errors['review.tone'] = '말투는 200자까지예요'
  const disclosure = f.disclosure.trim()
  if (chars(disclosure) > 200) errors.disclosure = '협찬 문구는 200자까지예요'

  const maxCompetition = num(f.maxCompetition)
  if (maxCompetition !== null && !(Number.isFinite(maxCompetition) && maxCompetition > 0))
    errors.maxCompetition = '0보다 큰 숫자를 넣거나 비워 주세요'
  const minPriceWon = num(f.minPriceWon)
  if (minPriceWon !== null && !(Number.isInteger(minPriceWon) && minPriceWon > 0))
    errors.minPriceWon = '1 이상의 정수를 넣거나 비워 주세요'
  const minChars = num(f.minChars) ?? Number.NaN
  const maxChars = num(f.maxChars) ?? Number.NaN
  if (!Number.isInteger(minChars) || minChars < 10)
    errors['review.minChars'] = '10 이상의 정수로 넣어 주세요'
  if (!Number.isInteger(maxChars) || maxChars < 50 || maxChars > 4000)
    errors['review.maxChars'] = '50~4000 사이의 정수로 넣어 주세요'
  if (!errors['review.minChars'] && !errors['review.maxChars'] && minChars >= maxChars)
    errors['review.minChars'] = '최대 글자 수보다 작아야 해요'

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    profile: {
      about,
      interests: lists.interests,
      preferKeywords: lists.preferKeywords,
      excludeKeywords: lists.excludeKeywords,
      excludeBrands: lists.excludeBrands,
      maxCompetition,
      minPriceWon,
      review: { tone, minChars, maxChars, points: lists['review.points'] },
      disclosure: disclosure === '' ? null : disclosure,
    },
  }
}

/** `interests.3` -> `interests`; `review.maxChars` stays. */
const fieldKey = (path: string): string => path.replace(/\.\d+$/, '')

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
  htmlFor: string
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

export function ProfileForm({
  profile,
  onCancel,
  onSaved,
  onError,
}: {
  profile: OpsProfile
  onCancel: () => void
  onSaved: () => void
  onError: (message: string) => void
}) {
  const id = useId()
  const [form, setForm] = useState<FormState>(() => toForm(profile))
  // The revision the form was filled from: polling may bring a newer profile while editing, and
  // saving these values on that newer revision would overwrite it instead of answering 409.
  const [revision] = useState(profile.revision)
  const [errors, setErrors] = useState<Errors>({})
  const save = useSaveProfile()
  const set = (k: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const pending = save.isPending

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const built = buildProfile(form)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    save.mutate(
      { revision, profile: built.profile },
      {
        onSuccess: onSaved,
        onError: (err) => {
          if (err instanceof ApiError && err.status === 400 && Array.isArray(err.body.fields)) {
            const next: Errors = {}
            for (const p of err.body.fields as string[]) next[fieldKey(p) as Key] = err.message
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

  const text = (key: Key, stateKey: keyof FormState, label: string, hint?: string) => (
    <Item label={label} hint={hint} error={errors[key]} htmlFor={`${id}-${stateKey}`}>
      <Input
        id={`${id}-${stateKey}`}
        value={form[stateKey]}
        aria-invalid={!!errors[key]}
        disabled={pending}
        onChange={(e) => set(stateKey)(e.target.value)}
      />
    </Item>
  )
  const numberField = (key: Key, stateKey: keyof FormState, label: string, hint?: string) => (
    <Item label={label} hint={hint} error={errors[key]} htmlFor={`${id}-${stateKey}`}>
      <Input
        id={`${id}-${stateKey}`}
        type="number"
        inputMode="numeric"
        min={0}
        value={form[stateKey]}
        aria-invalid={!!errors[key]}
        disabled={pending}
        onChange={(e) => set(stateKey)(e.target.value)}
      />
    </Item>
  )
  const list = (key: Key, stateKey: keyof FormState, label: string) => (
    <Item
      label={`${label} (${parseList(form[stateKey]).length}개)`}
      hint="한 줄에 하나씩 적어요"
      error={errors[key]}
      htmlFor={`${id}-${stateKey}`}
    >
      <Textarea
        id={`${id}-${stateKey}`}
        rows={3}
        value={form[stateKey]}
        aria-invalid={!!errors[key]}
        disabled={pending}
        onChange={(e) => set(stateKey)(e.target.value)}
      />
    </Item>
  )

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Item
        label="소개"
        error={errors.about}
        htmlFor={`${id}-about`}
        hint={`${chars(form.about)}/500자`}
      >
        <Textarea
          id={`${id}-about`}
          rows={3}
          value={form.about}
          aria-invalid={!!errors.about}
          disabled={pending}
          onChange={(e) => set('about')(e.target.value)}
        />
      </Item>
      {list('interests', 'interests', '관심사')}
      {list('preferKeywords', 'preferKeywords', '선호 키워드')}
      {list('excludeKeywords', 'excludeKeywords', '제외 키워드')}
      {list('excludeBrands', 'excludeBrands', '제외 브랜드')}
      <div className="grid gap-4 sm:grid-cols-2">
        {numberField('maxCompetition', 'maxCompetition', '최대 경쟁률', '비우면 제한 없음. 500이면 500:1까지')}
        {numberField('minPriceWon', 'minPriceWon', '최소 정가 (원)', '비우면 제한 없음')}
      </div>
      {text('review.tone', 'tone', '리뷰 말투')}
      <div className="grid gap-4 sm:grid-cols-2">
        {numberField('review.minChars', 'minChars', '최소 글자 수')}
        {numberField('review.maxChars', 'maxChars', '최대 글자 수')}
      </div>
      {list('review.points', 'points', '리뷰 포인트')}
      {text('disclosure', 'disclosure', '협찬 문구', '비우면 넣지 않아요. 모든 리뷰 초안 맨 앞에 붙어요')}
      <div className={SHEET_ACTIONS_CLASS}>
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
