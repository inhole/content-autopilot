// List the tabs open in Aside Browser without attaching to them.
const open = await listBrowserTabs()
return open.map((t) => ({ active: t.active, title: t.title, url: t.url }))
