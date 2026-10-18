import { type BrowserAgent, getBrowserAgent } from '../aside/client.ts'
import { query } from '../db/pool.ts'
import { downloadPhotos } from './photos.ts'
import { loadCampaign } from './store.ts'
import { MAX_CLAIM_ATTEMPTS, STALE_CLAIM_MINUTES } from './types.ts'

export type SaveOutcome = {
  /**
   * saved: DRAFT_SAVED. dry-run / failed: DRAFT_FAILED. retry: back to DRAFT_APPROVED, the
   * caller's sweep picks it up again. skipped: another worker owns the row or it moved on.
   */
  kind: 'saved' | 'dry-run' | 'retry' | 'failed' | 'skipped'
  error?: string
  screenshotPath?: string | null
}

export class LostClaimError extends Error {
  constructor() {
    super('blog save claim lost')
    this.name = 'LostClaimError'
  }
}

export type ParsedSaveResult =
  | { kind: 'saved' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown' }

/** Reads the agent's final `RESULT: SAVED` / `RESULT: FAILED <reason>` line (the last one wins). */
export function parseSaveResult(output: string | null): ParsedSaveResult {
  if (!output) return { kind: 'unknown' }
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*RESULT:\s*(SAVED|FAILED)\b[\s:-]*(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
  const last = lines[lines.length - 1]
  if (!last) return { kind: 'unknown' }
  if (last[1] === 'SAVED') return { kind: 'saved' }
  return { kind: 'failed', reason: (last[2] ?? '').trim() || '이유 없음' }
}

/**
 * The instruction for the Aside agent. SmartEditor ONE is too complex for a fixed script, so the
 * agent drives it. It must only save a temp draft, never publish.
 */
export function buildSaveTask(opts: { title: string; body: string; photos: string[] }): string {
  const photoLines = opts.photos.length
    ? opts.photos.map((p, i) => `[사진${i + 1}] -> ${p}`).join('\n')
    : '(사진 없음)'
  return [
    '로그인된 브라우저에서 네이버 블로그에 후기 글을 "임시저장"만 하는 작업이다. 절대 발행하지 마라.',
    '',
    '순서:',
    '1. https://blog.naver.com 을 연다(이미 로그인되어 있다). 로그인 화면이면 아무것도 입력하지 말고 RESULT: FAILED 로그인 필요 로 끝낸다.',
    '2. "글쓰기"로 새 글 편집기를 연다. "작성 중인 글이 있습니다" 같은 팝업이 뜨면 이어쓰기가 아니라 새로 쓰기(취소)를 고른다.',
    '3. 제목 입력란에 아래 [제목]을 그대로 입력한다.',
    '4. 본문에 아래 [본문]을 문단 구분을 유지해 그대로 입력한다. 내용을 고치거나 요약하지 마라.',
    '5. 본문의 [사진1], [사진2] 같은 표시는 그 자리에 해당 번호의 사진 파일을 업로드해 넣고, 표시 문구 자체는 지운다. 사진 파일 경로는 아래 [사진 목록]에 있다. 본문에 없는 번호의 사진은 글 맨 끝에 번호 순서대로 넣는다. 목록에 없는 번호의 표시는 문구만 지운다.',
    '6. 편집기 상단의 "저장"(임시저장) 버튼만 누르고 저장 완료 표시를 확인한다. "발행" 버튼은 누르지 마라. 발행 설정 창도 열지 마라.',
    '7. 마지막 줄에 정확히 `RESULT: SAVED` 를 출력한다. 어느 단계에서든 실패하면 마지막 줄에 `RESULT: FAILED <이유>` 를 출력한다. 저장 완료를 확인하지 못했다면 SAVED라고 쓰지 마라.',
    '',
    '[제목]',
    opts.title,
    '',
    '[사진 목록]',
    photoLines,
    '',
    '[본문]',
    opts.body,
  ].join('\n')
}

type Claimed = {
  title: string | null
  body: string | null
  attempts: number
  claim_seq: number
}

/**
 * Saves the approved draft as a Naver blog temp draft through Aside. Never publishes. Claims the
 * row like publishPost: the new claim_seq is the ownership token, every write is conditioned on
 * `status = 'DRAFT_SAVING' and claim_seq = token`, and ownership is re-checked right before the
 * browser side effect. Failures go back to DRAFT_APPROVED until MAX_CLAIM_ATTEMPTS, then
 * DRAFT_FAILED.
 *
 * An unknown outcome (timeout, no RESULT line) is retried, so it may leave a duplicate temp
 * draft in Naver. That is harmless: a temp draft is never a published post.
 */
export async function saveBlogDraft(
  campaignId: number,
  agent: BrowserAgent = getBrowserAgent(),
  photoOpts: Parameters<typeof downloadPhotos>[1] = {},
): Promise<SaveOutcome> {
  const [claimed] = await query<Claimed>(
    `update campaigns set status = 'DRAFT_SAVING', attempts = attempts + 1,
            claim_seq = claim_seq + 1, updated_at = now()
     where id = $1 and (status = 'DRAFT_APPROVED'
            or (status = 'DRAFT_SAVING' and updated_at < now() - make_interval(mins => $2)))
     returning draft_title as title, draft_body as body, attempts, claim_seq`,
    [campaignId, STALE_CLAIM_MINUTES],
  )
  if (!claimed) return { kind: 'skipped' }
  const token = claimed.claim_seq

  const ownedUpdate = async (set: string, params: unknown[] = []): Promise<boolean> =>
    (
      await query(
        `update campaigns set ${set}, updated_at = now()
         where id = $1 and status = 'DRAFT_SAVING' and claim_seq = $2 returning id`,
        [campaignId, token, ...params],
      )
    ).length > 0

  const fail = async (error: string): Promise<SaveOutcome> => {
    const exhausted = claimed.attempts >= MAX_CLAIM_ATTEMPTS
    const status = exhausted ? 'DRAFT_FAILED' : 'DRAFT_APPROVED'
    if (!(await ownedUpdate(`status = '${status}', last_error = $3`, [error.slice(0, 500)]))) {
      return { kind: 'skipped' }
    }
    return { kind: exhausted ? 'failed' : 'retry', error }
  }

  try {
    if (!claimed.title || !claimed.body) {
      await ownedUpdate(`status = 'DRAFT_FAILED', last_error = $3`, ['초안이 비어 있어요'])
      return { kind: 'failed', error: '초안이 비어 있어요' }
    }
    // A stale row resumed past the limit does not try again.
    if (claimed.attempts > MAX_CLAIM_ATTEMPTS) {
      return await fail('재시도 횟수를 넘었어요')
    }
    const photos = await downloadPhotos(campaignId, photoOpts)
    const task = buildSaveTask({ title: claimed.title, body: claimed.body, photos })

    // The ownership check doubles as a heartbeat; after this the save is out of our hands.
    if (!(await ownedUpdate('status = status'))) throw new LostClaimError()

    const output = await agent.runTask(task, { sideEffect: true })
    if (output === null) {
      // Dry-run: nothing was saved.
      const msg = '드라이런: 저장하지 않음'
      if (!(await ownedUpdate(`status = 'DRAFT_FAILED', last_error = $3`, [msg]))) {
        return { kind: 'skipped' }
      }
      return { kind: 'dry-run', error: msg }
    }

    const result = parseSaveResult(output)
    if (result.kind === 'saved') {
      if (
        !(await ownedUpdate(`status = 'DRAFT_SAVED', draft_saved_at = now(), last_error = null`))
      ) {
        return { kind: 'skipped' }
      }
      const c = await loadCampaign(campaignId)
      return { kind: 'saved', screenshotPath: c?.screenshot_path ?? null }
    }
    return await fail(
      result.kind === 'failed'
        ? `네이버 저장 실패: ${result.reason}`
        : `결과를 확인하지 못했어요: ${output.slice(-200)}`,
    )
  } catch (err) {
    if (err instanceof LostClaimError) return { kind: 'skipped' }
    return await fail((err as Error).message)
  }
}

/** Approved drafts waiting to be saved, plus saves abandoned by a crashed worker. */
export async function dueBlogSaveIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `select id from campaigns
     where status = 'DRAFT_APPROVED'
        or (status = 'DRAFT_SAVING' and updated_at < now() - make_interval(mins => $1))
     order by id`,
    [STALE_CLAIM_MINUTES],
  )
  return rows.map((r) => r.id)
}
