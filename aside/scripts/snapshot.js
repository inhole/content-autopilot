// Open a page in a new tab and return its title, final URL and accessibility tree, then close it.
// args: url, interactive?
const tab = await openTab(args.url)
try {
  const snap = await snapshot(tab, { interactive: args.interactive === 'true' })
  return { title: await tab.title(), url: tab.url(), tree: snap.tree }
} finally {
  await closeTab(tab)
}
