import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, CheckIcon, InfoIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/query-state.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card, CardContent } from '@/components/ui/card.tsx'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { ApiError, api, uploadVideoFile } from '@/lib/api.ts'
import { charCount, formatBytes, formatDuration, isHttpUrl } from '@/lib/format.ts'
import { refreshVideoData, useVideos } from '@/lib/queries.ts'
import type { VideoFileResponse } from '@/lib/types.ts'
import { parseHashtags } from '@/pages/video-detail.tsx'

// Owner uploads (docs/plans/video-upload.md 2, 7): the row first (title, caption, hashtags),
// then the file with progress. After a failure the row is read again to decide: still
// UPLOADING → send the file again to the same row; under review or approved → the file is in;
// expired → the next try starts a new row.

/**
 * Fallbacks until GET /api/videos answers with the server's limits (VIDEO_UPLOAD_MAX_MB); the
 * form only warns early, the server checks again.
 */
export const UPLOAD_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  minMs: 3_000,
  maxMs: 180_000,
  title: 100,
  hashtags: 5,
}

type Probe = { durationMs: number; width: number; height: number } | null

/** Reads length and size in the browser (best effort: some codecs it cannot play). */
function useFileProbe(file: File | null): Probe {
  const [probe, setProbe] = useState<Probe>(null)
  useEffect(() => {
    setProbe(null)
    if (!file || typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.onloadedmetadata = () =>
      setProbe({
        durationMs: Math.round(el.duration * 1000),
        width: el.videoWidth,
        height: el.videoHeight,
      })
    el.src = url
    return () => {
      el.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }, [file])
  return probe
}

export function fileWarnings(
  file: File,
  probe: Probe,
  maxBytes: number = UPLOAD_LIMITS.maxBytes,
): string[] {
  const out: string[] = []
  if (file.size > maxBytes) out.push(`${formatBytes(maxBytes)}를 넘어서 올릴 수 없어요`)
  if (probe) {
    if (probe.width > probe.height) out.push('가로 영상이에요. 세로 영상만 올릴 수 있어요')
    if (probe.durationMs < UPLOAD_LIMITS.minMs || probe.durationMs > UPLOAD_LIMITS.maxMs) {
      out.push('3초~3분 영상만 올릴 수 있어요')
    }
  }
  return out
}

type Done = { id: number; result: VideoFileResponse | null }

export function VideoUploadPage() {
  const client = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [caption, setCaption] = useState('')
  const [tags, setTags] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [approve, setApprove] = useState(true)
  // The UPLOADING row of this form, kept across retries while the fields stay as they were sent.
  const [videoId, setVideoId] = useState<number | null>(null)
  const [sentMeta, setSentMeta] = useState<string | null>(null)
  const limits = useVideos('active').data?.limits
  const maxBytes = limits?.uploadMaxBytes ?? UPLOAD_LIMITS.maxBytes
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const probe = useFileProbe(file)

  const hashtags = parseHashtags(tags)
  const warnings = file ? fileWarnings(file, probe, maxBytes) : []
  const meta = { title, caption, hashtags, sourceUrl: sourceUrl.trim() || null }
  const metaKey = JSON.stringify(meta)
  const titleLen = charCount(title.trim())
  const sourceOk = !sourceUrl.trim() || isHttpUrl(sourceUrl.trim())
  const ready =
    file !== null &&
    title.trim() !== '' &&
    titleLen <= UPLOAD_LIMITS.title &&
    new Set(hashtags).size <= UPLOAD_LIMITS.hashtags &&
    sourceOk &&
    !(file.size > maxBytes)
  const busy = progress !== null

  const pickFile = (f: File | null) => {
    setFile(f)
    setError(null)
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, UPLOAD_LIMITS.title))
  }

  /** After a failed file request: what does the row say now? */
  async function recover(id: number, failure: string) {
    try {
      const d = await api.video(id)
      if (d.video.status === 'PENDING_REVIEW' || d.video.status === 'APPROVED') {
        setDone({ id, result: null })
        return
      }
      if (d.video.status === 'EXPIRED') setVideoId(null)
    } catch {
      // keep the row; the next try reads it again
    }
    setError(failure)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || !file || busy) return
    setError(null)
    setProgress(0)
    // Fields changed after the row was made: start a new row (the old one expires unused), so
    // what gets approved is what the form shows.
    let id = videoId !== null && sentMeta === metaKey ? videoId : null
    try {
      if (id === null) {
        const created = await api.createVideo({ ...meta, originalName: file.name })
        id = created.id
        setVideoId(id)
        setSentMeta(metaKey)
      }
      const result = await uploadVideoFile(id, file, approve, (loaded, total) =>
        setProgress(total ? loaded / total : 0),
      )
      setDone({ id, result })
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const message = err instanceof Error ? err.message : '올리지 못했어요'
      // A rule the file broke, the size or the type: the row stays UPLOADING, pick another file.
      if (id === null || status === 400 || status === 413 || status === 415) setError(message)
      else await recover(id, `${message}. 다시 올려 주세요`)
    } finally {
      setProgress(null)
      void refreshVideoData(client)
    }
  }

  if (done) return <UploadDone done={done} />

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/videos">
          <ArrowLeftIcon data-icon="inline-start" />
          목록
        </Link>
      </Button>
      <PageHeader
        title="영상 올리기"
        description={`직접 만든 세로 영상(mp4·mov, 3초~3분, ${formatBytes(maxBytes)}까지)을 검수·예약 발행에 올려요`}
      />
      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="upload-file">영상 파일</FieldLabel>
                <Input
                  id="upload-file"
                  type="file"
                  accept="video/mp4,video/quicktime,.mp4,.mov"
                  disabled={busy}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <FieldDescription className="tabular-nums">
                    {file.name} · {formatBytes(file.size)}
                    {probe
                      ? ` · ${formatDuration(probe.durationMs)} · ${probe.width}×${probe.height}`
                      : ''}
                  </FieldDescription>
                )}
                {warnings.map((w) => (
                  <p key={w} className="text-sm text-destructive">
                    {w}
                  </p>
                ))}
              </Field>
              <Field>
                <FieldLabel htmlFor="upload-title">제목</FieldLabel>
                <Input
                  id="upload-title"
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <FieldDescription className="tabular-nums">
                  {titleLen}/{UPLOAD_LIMITS.title}자 · YouTube 제목
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="upload-caption">캡션</FieldLabel>
                <Textarea
                  id="upload-caption"
                  value={caption}
                  disabled={busy}
                  rows={4}
                  onChange={(e) => setCaption(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="upload-tags">해시태그</FieldLabel>
                <Input
                  id="upload-tags"
                  value={tags}
                  disabled={busy}
                  placeholder="#개발 #AI"
                  onChange={(e) => setTags(e.target.value)}
                />
                <FieldDescription>띄어쓰기로 나눠요 · {UPLOAD_LIMITS.hashtags}개까지</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="upload-source">출처 주소 (선택)</FieldLabel>
                <Input
                  id="upload-source"
                  type="url"
                  inputMode="url"
                  value={sourceUrl}
                  disabled={busy}
                  placeholder="https://"
                  onChange={(e) => setSourceUrl(e.target.value)}
                />
                <FieldDescription>캡션 끝에 "출처: 주소"로 붙어요</FieldDescription>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={approve}
                  disabled={busy}
                  onChange={(e) => setApprove(e.target.checked)}
                />
                올리면서 바로 승인 (다음 빈 영상 슬롯에 예약)
              </label>
            </FieldGroup>

            <Alert>
              <InfoIcon />
              <AlertDescription>
                Reels·Shorts는 9:16 세로 영상을 권장해요. 1분 넘는 Shorts에 음악이 있으면 저작권
                클레임으로 재생이 막힐 수 있으니 발행 뒤 YouTube Studio에서 확인하세요.
              </AlertDescription>
            </Alert>

            {error && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-fit" disabled={!ready || busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              {busy ? `올리는 중 ${Math.round((progress ?? 0) * 100)}%` : '올리기'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  )
}

function UploadDone({ done }: { done: Done }) {
  const approval = done.result?.approval ?? null
  return (
    <>
      <PageHeader title="영상 올리기" />
      <Alert role="status">
        <CheckIcon />
        <AlertDescription>
          {approval?.ok
            ? approval.at
              ? '올리고 승인했어요. 예약 시각에 발행돼요.'
              : '올리고 승인했어요. 자동 발행 플랫폼이 없어서 직접 올리기 안내가 텔레그램으로 가요.'
            : approval
              ? `올렸지만 승인하지 못했어요: ${approval.error}. 검수 대기로 남았어요.`
              : '올렸어요. 검수 대기로 들어갔고 텔레그램에도 검수 메시지가 가요.'}
        </AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button asChild size="sm">
          <Link to={`/videos/${done.id}`}>영상 보기</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/videos">목록</Link>
        </Button>
      </div>
    </>
  )
}
