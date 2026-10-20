// GET a URL with the owner's cookies and return status, content type and body (JSON parsed).
// A tab on the URL's origin is opened first when none is open, and closed again afterwards.
// args: url
const origin = new URL(args.url).origin
const existing = (await listBrowserTabs()).some((t) => t.url?.startsWith(origin))
const tab = existing ? null : await openTab(origin)
try {
  const res = await fetch(args.url)
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  let body = text.length > 20000 ? `${text.slice(0, 20000)}…(${text.length} chars)` : text
  if (type.includes('json')) {
    try {
      body = JSON.parse(text)
    } catch {}
  }
  return { status: res.status, type, body }
} finally {
  if (tab) await closeTab(tab)
}
