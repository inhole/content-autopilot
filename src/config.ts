import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({ quiet: true })

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')

const schema = z.object({
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
    .default('08:00,12:30,19:00')
    .transform((s) => s.split(',').map((t) => t.trim())),

  // Dead man's switch pings (healthchecks.io style); unset disables them.
  HEALTHCHECK_URL: z.url().optional(),
  HEALTHCHECK_DAILY_URL: z.url().optional(),
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
