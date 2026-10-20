import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({ quiet: true })

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')

export const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Defaults to true because production runs on Supabase; CI and local Postgres have no SSL.
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  OPENROUTER_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-5.5'),
  LLM_RANK_MODEL: z.string().default('anthropic/claude-haiku-4.5'),

  THREADS_API_BASE: z.string().default('https://graph.threads.net'),
  // Seed values; after the first run the token lives in platform_accounts and is refreshed there.
  // Only for the one-time token setup (`npm run cli -- threads:auth-url` / `threads:token`).
  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),
  THREADS_USER_ID: z.string().optional(),
  THREADS_ACCESS_TOKEN: z.string().optional(),
  THREADS_DRY_RUN: bool,

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.coerce.number().optional(),

  TZ_NAME: z.string().default('Asia/Seoul'),
  COLLECT_CRON: z.string().default('0 6 * * *'),
  DAILY_POST_COUNT: z.coerce.number().int().min(1).max(10).default(3),
  // Local times (TZ_NAME) at which approved posts go out, one post per slot.
  PUBLISH_SLOTS: z
    .string()
    .default('08:00,12:30,21:00')
    .transform((s) => s.split(',').map((t) => t.trim())),

  // Thread chains (docs/decisions.md 8): drafts get up to two follow-up replies. Only affects
  // generation; a post that already has parts is published as a chain either way.
  THREAD_CHAIN_ENABLED: bool,
  // Fixed text appended to the last follow-up of a chain, never to a single post. `\n` in the
  // value becomes a line break. Unset: no CTA.
  THREAD_CTA_TEXT: z
    .string()
    .max(200)
    .optional()
    .transform((s) => s?.replace(/\\n/g, '\n').trim() || undefined),

  // Kakao gift trial campaigns (docs/plans/campaign-autopilot.md). The list is a public page;
  // applying and reviewing happen by hand in the KakaoTalk mobile app.
  GIFT_COLLECT_CRON: z.string().default('0 9,15,21 * * *'),
  // gift.kakao.com/page/<id>: the 체험단 tab of 선물하기.
  GIFT_TRIAL_PAGE_ID: z.coerce.number().int().default(33325),
  CAMPAIGN_DAILY_MAX: z.coerce.number().int().min(1).max(20).default(5),
  CAMPAIGN_PROFILE_PATH: z.string().default('config/campaign-profile.json'),

  // Musinsa 체험단 (preuser) trials (docs/plans/campaign-autopilot.md). The list is public.
  MUSINSA_COLLECT_CRON: z.string().default('0 10,16,22 * * *'),

  // Aside browser on the owner's PC, driven by `aside repl` scripts in aside/scripts (docs/aside.md).
  // Default: %LOCALAPPDATA%\Aside\CLI\current\aside.exe when it exists, else `aside` from PATH.
  ASIDE_BIN: z.string().optional(),
  ASIDE_ACCOUNT: z.string().optional(),

  // Read-only web dashboard (docs/dashboard.md). Off unless a password is set. Railway injects PORT.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DASHBOARD_PASSWORD: z.string().optional(),
  // Public https origin of the dashboard server (no path). Gift cards then open KakaoTalk through
  // `${PUBLIC_BASE_URL}/go/gift/<id>`; the dashboard must be enabled for that route to exist.
  PUBLIC_BASE_URL: z
    .string()
    .refine((v) => /^https:\/\/[^/?#\s]+\/?$/.test(v), 'must be an https origin without a path')
    .transform((v) => v.replace(/\/$/, ''))
    .optional(),
})

export type Config = z.infer<typeof schema>

// `KEY=` lines in .env mean "not set", not an empty value.
export const config: Config = schema.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
)

export function requireValue<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key]
  if (value === undefined || value === null || value === '') {
    throw new Error(`${key} is not set`)
  }
  return value as NonNullable<Config[K]>
}
