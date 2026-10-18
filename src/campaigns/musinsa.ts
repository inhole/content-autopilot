import { z } from 'zod'
import { type BrowserAgent, getBrowserAgent } from '../aside/client.ts'

export const MUSINSA_LIST_URL = 'https://influencer.musinsa.com/api2/mcmp/v2/recruitment-campaigns'
const MUSINSA_HOME = 'https://www.musinsa.com/preuser/main'
const MAX_PAGES = 20

/** The campaign page the owner opens on a PC to apply. */
export const musinsaEventUrl = (campaignId: number | string) =>
  `https://www.musinsa.com/preuser/events/${campaignId}`

export const MusinsaItemSchema = z
  .object({
    campaignId: z.number().int(),
    // Local KST time without an offset, e.g. 2026-10-20T23:59:59.
    campaignEndDate: z.string(),
    brandName: z.string().nullish(),
    representativeGoods: z
      .object({
        goodsImageUrl: z.string().nullish(),
        goodsName: z.string(),
        price: z.number().nullish(),
      })
      .passthrough(),
    goodsCount: z.number().int().nullish(),
    contentType: z.string().nullish(),
  })
  .passthrough()
export type MusinsaItem = z.infer<typeof MusinsaItemSchema>

export const MusinsaListSchema = z
  .object({
    data: z.object({ list: z.array(z.unknown()) }).passthrough(),
    link: z.object({ next: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough()

/** What MUSINSA_LIST_SCRIPT returns. `items` are the raw `data.list` entries of every page. */
export type MusinsaScriptResult = { status: number; items: unknown[]; loggedIn: boolean }

export class MusinsaLoginError extends Error {
  constructor() {
    super(
      '무신사에 로그인되어 있지 않습니다. PC에서 Aside를 실행하고 musinsa.com에 로그인한 뒤 다시 시도하세요.',
    )
    this.name = 'MusinsaLoginError'
  }
}

/**
 * Runs inside `aside repl`: the list needs the owner's Musinsa cookies, so it is read with the
 * cookie-bearing `fetch` once a musinsa.com tab exists. Follows `link.next` (max 20 pages, 300 ms
 * apart). A 401 on any page means logged out.
 */
export const MUSINSA_LIST_SCRIPT = `
const tabsNow = await listBrowserTabs()
if (!tabsNow.some((t) => /^https:\\/\\/([a-z0-9-]+\\.)?musinsa\\.com\\//.test(String(t.url ?? '')))) {
  await openTab(${JSON.stringify(MUSINSA_HOME)})
  await sleep(2000)
}
const items = []
let url = ${JSON.stringify(MUSINSA_LIST_URL)}
let status = 0
for (let page = 0; url && page < ${MAX_PAGES}; page++) {
  if (page > 0) await sleep(300)
  const res = await fetch(url)
  status = res.status
  if (status === 401) return { status, items: [], loggedIn: false }
  if (!res.ok) return { status, items, loggedIn: true }
  const body = await res.json()
  items.push(...(body?.data?.list ?? []))
  const next = body?.link?.next
  url = next ? new URL(next, url).toString() : null
}
return { status, items, loggedIn: true }`

export type MusinsaList = { items: MusinsaItem[]; invalid: number }

export async function fetchMusinsaList(
  agent: BrowserAgent = getBrowserAgent(),
): Promise<MusinsaList> {
  const res = await agent.runScript<MusinsaScriptResult>(MUSINSA_LIST_SCRIPT)
  if (!res.loggedIn) throw new MusinsaLoginError()
  if (res.status !== 200) throw new Error(`musinsa list failed: HTTP ${res.status}`)
  const items: MusinsaItem[] = []
  let invalid = 0
  for (const raw of res.items) {
    const parsed = MusinsaItemSchema.safeParse(raw)
    if (parsed.success) items.push(parsed.data)
    else invalid++
  }
  // A list of only unparseable items means the API shape changed; do not look like an empty list.
  if (items.length === 0 && invalid > 0)
    throw new Error(`musinsa list: all ${invalid} items invalid`)
  return { items, invalid }
}

/** `2026-10-20T23:59:59` (KST wall time) as the real instant. Throws on a malformed value. */
export function parseMusinsaEndDate(value: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(value)
  if (!m) throw new Error(`unexpected musinsa end date: ${value}`)
  const d = new Date(`${m[1]}T${m[2]}+09:00`)
  if (Number.isNaN(d.getTime())) throw new Error(`unexpected musinsa end date: ${value}`)
  return d
}

/** Campaign title: the representative goods name, prefixed `[+N]` for the N further goods. */
export function musinsaTitle(item: MusinsaItem): string {
  const name = item.representativeGoods.goodsName.trim()
  const extra = (item.goodsCount ?? 1) - 1
  return extra > 0 ? `[+${extra}] ${name}` : name
}
