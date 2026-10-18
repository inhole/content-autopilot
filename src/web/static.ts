import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Lookup of the built React app (`web/dist`) files. Headers are set by server.ts. */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export type StaticFile = {
  body: Buffer
  type: string
  /** Hashed build output under /assets/: safe to cache for a long time. */
  immutable: boolean
  /** The SPA entry page (also served for client-side routes). */
  isIndex: boolean
}

/** `WEB_DIST_DIR` if set, else `<repo>/web/dist`. */
export function defaultDistDir(): string {
  return process.env.WEB_DIST_DIR || fileURLToPath(new URL('../../web/dist', import.meta.url))
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** True when the build exists (checked per request, so a build created later is picked up). */
export function hasBuild(distDir: string): Promise<boolean> {
  return isFile(path.join(distDir, 'index.html'))
}

/**
 * Looks up a request path inside `distDir`. Returns:
 * - the file when it exists, or index.html for a client-side route (a path without extension),
 * - 'bad' for a malformed path or one that tries to leave `distDir`,
 * - null for a missing /assets/ file or a missing file with an extension (a real 404).
 */
export async function lookupStatic(
  distDir: string,
  pathname: string,
): Promise<StaticFile | 'bad' | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return 'bad'
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return 'bad'
  if (decoded.split('/').some((seg) => seg === '..')) return 'bad'

  const root = path.resolve(distDir)
  const target = path.resolve(root, `.${decoded}`)
  if (target !== root && !target.startsWith(root + path.sep)) return 'bad'

  const ext = path.extname(target).toLowerCase()
  const isIndexPath = decoded === '/'
  if (!isIndexPath && ext && (await isFile(target))) {
    return {
      body: await readFile(target),
      type: TYPES[ext] ?? 'application/octet-stream',
      immutable: decoded.startsWith('/assets/'),
      isIndex: false,
    }
  }
  if (decoded.startsWith('/assets/') || (!isIndexPath && ext)) return null
  return {
    body: await readFile(path.join(root, 'index.html')),
    type: TYPES['.html'] as string,
    immutable: false,
    isIndex: true,
  }
}
