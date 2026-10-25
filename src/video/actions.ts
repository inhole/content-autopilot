import type { Readable } from 'node:stream'
import { clearButtons } from '../campaigns/tg.ts'
import { query } from '../db/pool.ts'
import {
  type Approval,
  approveVideo,
  cancelPublication,
  type FailedGuard,
  publishPublicationNow,
  retryFailedPublication,
  VideoNotReviewableError,
} from './approve.ts'
import type { VideoStorage } from './storage.ts'
import {
  applyMetaEdit,
  loadVideo,
  type MetaEdit,
  markManualPublished,
  rejectVideo,
  requestRescript,
  unapproveVideo,
  type VideoRow,
} from './store.ts'
import {
  approvedVideoText,
  cancelledText,
  formatVideoTime,
  notifyVideo,
  sendManualUpload,
} from './telegram.ts'
import { createUpload, type FileOutcome, type NewUpload, receiveUpload } from './upload.ts'

/**
 * Video operations of the web console (docs/plans/video-upload.md 6). Each runs the same
 * conditional transition as the Telegram button or reply, on the revision (or attempt, or slot)
 * the page displayed, and then leaves Telegram as the equivalent press would. Telegram is best
 * effort and reported in `telegramSynced`.
 */

export type VideoActionOutcome =
  | { ok: true; telegramSynced: boolean }
  | { ok: false; reason: 'not_found' | 'stale' | 'invalid' | 'confirm'; message: string }

export type FileActionOutcome =
  | (Extract<FileOutcome, { kind: 'stored' }> & { telegramSynced: boolean })
  | Exclude<FileOutcome, { kind: 'stored' }>

export type VideoActions = {
  create(
    p: NewUpload,
  ): Promise<{ ok: true; id: number; revision: number } | { ok: false; message: string }>
  /** The file step; throws UploadBusyError / UploadTooLargeError like receiveUpload. */
  receiveFile(id: number, body: Readable, p: { approve: boolean }): Promise<FileActionOutcome>
  approve(id: number, p: { revision: number }): Promise<VideoActionOutcome>
  unapprove(id: number, p: { revision: number }): Promise<VideoActionOutcome>
  reject(id: number, p: { revision: number }): Promise<VideoActionOutcome>
  edit(id: number, p: MetaEdit & { revision: number }): Promise<VideoActionOutcome>
  rescript(id: number, p: { revision: number; feedback?: string }): Promise<VideoActionOutcome>
  manualDone(id: number, p: { revision: number }): Promise<VideoActionOutcome>
  publishNow(publicationId: number, p: { scheduledAt: Date }): Promise<VideoActionOutcome>
  retry(publicationId: number, p: FailedGuard): Promise<VideoActionOutcome>
  cancel(publicationId: number, p: FailedGuard): Promise<VideoActionOutcome>
  /** The video a publication belongs to, or null. */
  videoOfPublication(publicationId: number): Promise<number | null>
}

/** What the worker hands over: the queues live there. */
export type VideoActionDeps = {
  enqueueReview(videoId: number): Promise<void>
  enqueueScript(videoId: number, seq: number): Promise<void>
  storage?: VideoStorage
}

export const VIDEO_STALE_MESSAGE = '이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요'

const stale = (message = VIDEO_STALE_MESSAGE): VideoActionOutcome => ({
  ok: false,
  reason: 'stale',
  message,
})
const notFound = (): VideoActionOutcome => ({
  ok: false,
  reason: 'not_found',
  message: 'not found',
})

async function bestEffort(label: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step()
    return true
  } catch (err) {
    console.error(`[video] web action: telegram ${label} failed`, (err as Error).message)
    return false
  }
}

/** The review message loses its buttons, as after a press. */
async function retireReview(v: VideoRow | null): Promise<void> {
  if (v?.review_chat_id != null && v.review_message_id != null) {
    await clearButtons(v.review_chat_id, v.review_message_id)
  }
}

/** Telegram after an approval: the review buttons go, the confirmation (and manual handoff) come. */
async function syncApproval(before: VideoRow | null, id: number, approval: Approval) {
  return bestEffort('approve', async () => {
    await retireReview(before)
    await notifyVideo(approvedVideoText(id, approval))
    if (!approval.at) await sendManualUpload(id)
  })
}

export function createVideoActions(deps: VideoActionDeps): VideoActions {
  return {
    create: (p) => createUpload(p),

    async receiveFile(id, body, p) {
      const out = await receiveUpload(id, body, p, {
        enqueueReview: deps.enqueueReview,
        ...(deps.storage ? { storage: deps.storage } : {}),
      })
      if (out.kind !== 'stored') return out
      const telegramSynced = out.approval?.ok
        ? await syncApproval(null, id, out.approval.approval)
        : true
      return { ...out, telegramSynced }
    },

    async approve(id, p) {
      const before = await loadVideo(id)
      if (!before) return notFound()
      let approval: Approval
      try {
        approval = await approveVideo(id, { revision: p.revision })
      } catch (err) {
        if (err instanceof VideoNotReviewableError) return stale()
        // Account not set up and the like: the owner can fix it and press again.
        return { ok: false, reason: 'invalid', message: (err as Error).message }
      }
      return { ok: true, telegramSynced: await syncApproval(before, id, approval) }
    },

    async unapprove(id, p) {
      if (!(await loadVideo(id))) return notFound()
      const r = await unapproveVideo(id, p.revision)
      if (!r.ok) return r.stale ? stale() : { ok: false, reason: 'invalid', message: r.message }
      // Back under review: a fresh review message (the old one lost its buttons at approval).
      return { ok: true, telegramSynced: await bestEffort('review', () => deps.enqueueReview(id)) }
    },

    async reject(id, p) {
      const before = await loadVideo(id)
      if (!before) return notFound()
      if (!(await rejectVideo(id, { revision: p.revision }))) return stale()
      const telegramSynced = await bestEffort('reject', async () => {
        await retireReview(before)
        await notifyVideo(`🗑 영상 #${id} 폐기`)
      })
      return { ok: true, telegramSynced }
    },

    async edit(id, p) {
      if (!(await loadVideo(id))) return notFound()
      const r = await applyMetaEdit(id, { revision: p.revision }, p)
      if (!r.ok) return r.stale ? stale() : { ok: false, reason: 'invalid', message: r.message }
      // The review message shows the old text: re-send it (the old one loses its buttons).
      return { ok: true, telegramSynced: await bestEffort('review', () => deps.enqueueReview(id)) }
    },

    async rescript(id, p) {
      const before = await loadVideo(id)
      if (!before) return notFound()
      if (before.origin !== 'generated') {
        return { ok: false, reason: 'invalid', message: '직접 올린 영상은 다시 만들 수 없어요' }
      }
      const seq = await requestRescript(id, { revision: p.revision }, p.feedback?.trim() || null)
      if (seq === null) return stale()
      await deps.enqueueScript(id, seq)
      const telegramSynced = await bestEffort('rescript', async () => {
        await retireReview(before)
        await notifyVideo(`🔁 영상 #${id} 원고를 다시 쓰는 중…`)
      })
      return { ok: true, telegramSynced }
    },

    async manualDone(id, p) {
      if (!(await loadVideo(id))) return notFound()
      if (!(await markManualPublished(id, p.revision))) return stale()
      const telegramSynced = await bestEffort('manual', () =>
        notifyVideo(`📤 영상 #${id} 직접 올림으로 기록했어요`),
      )
      return { ok: true, telegramSynced }
    },

    async publishNow(publicationId, p) {
      if (!(await publishPublicationNow(publicationId, p.scheduledAt))) return stale()
      return { ok: true, telegramSynced: true }
    },

    async retry(publicationId, p) {
      const r = await retryFailedPublication(publicationId, p)
      if (!r.ok) return { ok: false, reason: r.reason, message: r.message }
      const telegramSynced = await bestEffort('retry', () =>
        notifyVideo(`🔁 발행 #${publicationId}을 ${formatVideoTime(r.at)}에 다시 발행해요`),
      )
      return { ok: true, telegramSynced }
    },

    async videoOfPublication(publicationId) {
      const [row] = await query<{ video_id: number }>(
        'select video_id from video_publications where id = $1',
        [publicationId],
      )
      return row?.video_id ?? null
    },

    async cancel(publicationId, p) {
      const r = await cancelPublication(publicationId, p)
      if (!r.ok) return { ok: false, reason: r.reason, message: r.message }
      const telegramSynced = await bestEffort('cancel', () =>
        notifyVideo(cancelledText(r.videoId, r.finished)),
      )
      return { ok: true, telegramSynced }
    },
  }
}
