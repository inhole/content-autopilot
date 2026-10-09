const TIMEOUT_MS = 10_000

export type PingKind = 'success' | 'fail'

/**
 * Pings a healthchecks.io-style URL: GET `<url>` means success, GET `<url>/fail` means failure.
 * The worker's own alerts cannot fire when the worker is dead, so an external service has to
 * notice the missing ping instead. A ping failure must never break the job it reports on, so
 * this never throws. Does nothing when the URL is unset.
 */
export async function pingHealthcheck(
  url: string | undefined,
  kind: PingKind = 'success',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) return
  const target = kind === 'fail' ? `${url.replace(/\/+$/, '')}/fail` : url
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) console.warn(`[healthcheck] ${kind} ping returned HTTP ${res.status}`)
  } catch (err) {
    // The URL embeds a secret-ish uuid, so only the error is logged.
    console.warn(`[healthcheck] ${kind} ping failed: ${(err as Error).message}`)
  }
}
