import { type RevuMyPageStatus, revuCampaignUrl, revuMyCampaignsUrl } from './revu-urls.ts'

// Aside REPL script bodies for revu. Each runs as the body of an async function with `openTab`
// in scope and returns a JSON-serializable value (see READ_PAGE_SCRIPT in src/aside/client.ts).
//
// UNVERIFIED until the Phase 0 spike: nothing here has run against the real revu DOM or the real
// Aside REPL. The scripts are deliberately defensive: they locate elements by visible text, and
// report `{ submitted: false, reason }` instead of throwing when an element is missing, so the
// caller can decide between retry and giving up. Every input is embedded with JSON.stringify.

export type ListMyCampaignsResult = { ids: string[]; loggedIn: boolean }
export type ApplyScriptResult = { submitted: boolean; reason?: string }

/**
 * Lists the external ids of the owner's campaigns on one stage of the revu "my page". Loads every
 * page behind a "더보기" button. `loggedIn` is false when the page shows a login form.
 */
export const LIST_MY_CAMPAIGN_IDS_SCRIPT = (status: RevuMyPageStatus) => `
const p = await openTab(${JSON.stringify(revuMyCampaignsUrl(status))})
if (p.waitForLoadState) await p.waitForLoadState('networkidle').catch(() => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1500)
const loggedIn = await p.evaluate(() => {
  const hasPassword = !!document.querySelector('input[type="password"]')
  const path = location.pathname
  return !hasPassword && !/login|signin/i.test(path)
})
if (!loggedIn) return { ids: [], loggedIn: false }
for (let i = 0; i < 20; i++) {
  const clicked = await p.evaluate(() => {
    const more = [...document.querySelectorAll('button, a')].find(
      (el) => /더\\s*보기/.test(el.textContent || '') && el.offsetParent !== null,
    )
    if (!more) return false
    more.click()
    return true
  })
  if (!clicked) break
  await sleep(1200)
}
const ids = await p.evaluate(() => {
  const found = new Set()
  for (const a of document.querySelectorAll('a[href*="/campaign/"]')) {
    const m = (a.getAttribute('href') || '').match(/\\/campaign\\/(\\d+)/)
    if (m) found.add(m[1])
  }
  return [...found]
})
return { ids, loggedIn: true }`

/**
 * Applies to one campaign: opens its page, presses the apply button (text contains 신청), fills
 * the message, ticks the required agreement boxes and presses the final submit.
 */
export const APPLY_SCRIPT = (externalId: string, applyMessage: string) => `
const p = await openTab(${JSON.stringify(revuCampaignUrl(externalId))})
if (p.waitForLoadState) await p.waitForLoadState('networkidle').catch(() => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1500)
const message = ${JSON.stringify(applyMessage)}

// Opens the form. Buttons are found by visible text because the real markup is not verified.
const opened = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button, a')].find(
    (el) => /신청/.test(el.textContent || '') && !/취소|완료|마감/.test(el.textContent || '') && el.offsetParent !== null,
  )
  if (!btn) return false
  btn.click()
  return true
})
if (!opened) return { submitted: false, reason: '신청 버튼을 찾지 못했어요' }
await sleep(1500)

const filled = await p.evaluate((msg) => {
  const area = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null)
  if (!area) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(area, msg)
  area.dispatchEvent(new Event('input', { bubbles: true }))
  area.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}, message)
if (!filled) return { submitted: false, reason: '신청 메시지 입력칸을 찾지 못했어요' }

await p.evaluate(() => {
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    if (!box.checked && !box.disabled) box.click()
  }
})
await sleep(500)

const submitted = await p.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')].filter((el) => el.offsetParent !== null)
  const btn =
    buttons.reverse().find((el) => /(신청|제출|완료)/.test(el.textContent || '') && !el.disabled)
  if (!btn) return false
  btn.click()
  return true
})
if (!submitted) return { submitted: false, reason: '최종 제출 버튼을 찾지 못했거나 비활성 상태예요' }
await sleep(2500)
return { submitted: true }`

/** Best effort screenshot of a page to a local path; resolves to `{ ok }` and never throws. */
export const SCREENSHOT_SCRIPT = (url: string, path: string) => `
try {
  const p = await openTab(${JSON.stringify(url)})
  if (p.waitForLoadState) await p.waitForLoadState('networkidle').catch(() => {})
  await p.screenshot({ path: ${JSON.stringify(path)}, fullPage: true })
  return { ok: true }
} catch (err) {
  return { ok: false, error: String(err && err.message ? err.message : err) }
}`
