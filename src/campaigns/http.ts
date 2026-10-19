const REQUEST_TIMEOUT_MS = 15_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${new URL(url).host} responded ${status} for ${url}`)
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500
  if (err instanceof DOMException) return err.name === 'TimeoutError' || err.name === 'AbortError'
  return err instanceof TypeError // network failure
}

export type GetJson = (url: string) => Promise<unknown>

/** GET JSON with a timeout; a 429, 5xx, timeout or network failure is retried once. */
export function makeGetJson(opts: {
  fetch: typeof fetch
  retryDelayMs: number
  userAgent: string
}): GetJson {
  const once = async (url: string) => {
    const res = await opts.fetch(url, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new HttpError(res.status, url)
    return (await res.json()) as unknown
  }
  return async (url) => {
    try {
      return await once(url)
    } catch (err) {
      if (!isRetryable(err)) throw err
      await sleep(opts.retryDelayMs)
      return once(url)
    }
  }
}
