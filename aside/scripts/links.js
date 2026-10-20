// Open a page in a new tab and return its links (text and absolute href), then close it.
// `match` keeps only links whose text or href contains it.
// args: url, match?
const tab = await openTab(args.url)
try {
  const all = await tab.$$eval('a[href]', (as) =>
    as.map((a) => ({ text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.href })),
  )
  const seen = new Set()
  return all.filter((l) => {
    if (seen.has(l.href)) return false
    seen.add(l.href)
    return !args.match || l.text.includes(args.match) || l.href.includes(args.match)
  })
} finally {
  await closeTab(tab)
}
