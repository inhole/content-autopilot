import { useMutation, useQueryClient } from '@tanstack/react-query'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { ActivityIcon, SendIcon, TriangleAlertIcon } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field.tsx'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { ApiError, api, setCsrfToken } from '@/lib/api.ts'
import { SESSION_KEY, useSession } from '@/lib/queries.ts'

const CODE_LENGTH = 6
const RESEND_SECONDS = 60

/** Where to go after logging in: the page that sent us here, never the login page itself. */
function returnTo(state: unknown): string {
  const from = (state as { from?: { pathname?: string; search?: string } } | null)?.from
  if (!from?.pathname || from.pathname === '/login') return '/'
  return `${from.pathname}${from.search ?? ''}`
}

/** Seconds left on a countdown that restarts whenever `start` is called. */
function useCountdown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= now) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [until, now])
  const left = Math.max(0, Math.ceil((until - now) / 1000))
  return [
    left,
    (seconds) => {
      const t = Date.now()
      setNow(t)
      setUntil(t + seconds * 1000)
    },
  ]
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류예요')

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [cooldown, startCooldown] = useCountdown()

  const request = useMutation({
    mutationFn: api.requestCode,
    onSuccess: () => {
      setSent(true)
      setCode('')
      startCooldown(RESEND_SECONDS)
    },
    onError: (e) => {
      if (e instanceof ApiError && e.retryAfter) startCooldown(e.retryAfter)
    },
  })
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (s) => {
      if (!s.authenticated) return
      setCsrfToken(s.csrf)
      client.setQueryData(SESSION_KEY, s)
      navigate(returnTo(location.state), { replace: true })
    },
    onError: () => setCode(''),
  })

  if (session.data?.authenticated) return <Navigate to={returnTo(location.state)} replace />

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length === CODE_LENGTH && !login.isPending) login.mutate(code)
  }
  const error = login.error ?? request.error

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ActivityIcon />
          </div>
          <CardTitle>Content Autopilot 관리자</CardTitle>
          <CardDescription>Telegram으로 받은 6자리 코드로 로그인해요</CardDescription>
        </CardHeader>
        <CardContent>
          {session.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <form onSubmit={submit}>
              <FieldGroup>
                {error && (
                  <Alert variant="destructive">
                    <TriangleAlertIcon />
                    <AlertDescription>{errorText(error)}</AlertDescription>
                  </Alert>
                )}
                {sent ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="login-code">로그인 코드</FieldLabel>
                      <InputOTP
                        id="login-code"
                        maxLength={CODE_LENGTH}
                        pattern={REGEXP_ONLY_DIGITS}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        value={code}
                        onChange={setCode}
                        onComplete={(value: string) => {
                          if (!login.isPending) login.mutate(value)
                        }}
                        disabled={login.isPending}
                        containerClassName="justify-center"
                      >
                        <InputOTPGroup>
                          {Array.from({ length: CODE_LENGTH }, (_, i) => (
                            <InputOTPSlot key={i} index={i} />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                      <FieldDescription className="text-center">
                        5분 동안 한 번만 쓸 수 있어요
                      </FieldDescription>
                    </Field>
                    <Button type="submit" disabled={code.length !== CODE_LENGTH || login.isPending}>
                      {login.isPending && <Spinner data-icon="inline-start" />}
                      로그인
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    onClick={() => request.mutate()}
                    disabled={request.isPending || cooldown > 0}
                  >
                    {request.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <SendIcon data-icon="inline-start" />
                    )}
                    {cooldown > 0
                      ? `${cooldown}초 뒤에 다시 받을 수 있어요`
                      : 'Telegram으로 코드 받기'}
                  </Button>
                )}
              </FieldGroup>
            </form>
          )}
        </CardContent>
        {sent && (
          <CardFooter className="justify-center">
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => request.mutate()}
              disabled={request.isPending || cooldown > 0}
            >
              {cooldown > 0 ? `${cooldown}초 뒤에 코드 다시 받기` : '코드 다시 받기'}
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
