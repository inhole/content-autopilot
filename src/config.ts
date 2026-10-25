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
  // How surviving candidates are scored: `rule` in code (no LLM call), `llm` with LLM_RANK_MODEL.
  CAMPAIGN_RANK_MODE: z.enum(['rule', 'llm']).default('rule'),
  CAMPAIGN_PROFILE_PATH: z.string().default('config/campaign-profile.json'),

  // Musinsa 체험단 (preuser) trials (docs/plans/campaign-autopilot.md). The list is public.
  MUSINSA_COLLECT_CRON: z.string().default('0 10,16,22 * * *'),

  // Aside browser on the owner's PC, driven by `aside repl` scripts in aside/scripts (docs/aside.md).
  // Default: %LOCALAPPDATA%\Aside\CLI\current\aside.exe when it exists, else `aside` from PATH.
  ASIDE_BIN: z.string().optional(),
  ASIDE_ACCOUNT: z.string().optional(),

  // Web dashboard (docs/dashboard.md). Runs when Telegram is configured, since login codes are sent
  // there. Railway injects PORT.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Public https origin of the dashboard server (no path). Gift cards then open KakaoTalk through
  // `${PUBLIC_BASE_URL}/go/gift/<id>`; the dashboard must be enabled for that route to exist.
  PUBLIC_BASE_URL: z
    .string()
    .refine((v) => /^https:\/\/[^/?#\s]+\/?$/.test(v), 'must be an https origin without a path')
    .transform((v) => v.replace(/\/$/, ''))
    .optional(),

  // Short-form videos (docs/plans/video.md). VIDEO_ENABLED only schedules the automatic pick;
  // /video and the CLI work either way.
  VIDEO_ENABLED: bool,
  VIDEO_CRON: z.string().default('0 7 * * 2,4,6'),
  VIDEO_WEEKLY_MAX: z.coerce.number().int().min(1).max(14).default(3),
  // One local time per day, so one video per platform per day.
  VIDEO_PUBLISH_SLOT: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')
    .default('19:00'),
  // Platforms published automatically after approval; empty = the owner uploads by hand.
  VIDEO_PLATFORMS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['reels', 'shorts']))),
  VIDEO_PUBLISH_DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  VIDEO_BRAND: z.string().max(40).optional(),
  VIDEO_TTS_PROVIDER: z.enum(['silent', 'google', 'openai', 'elevenlabs']).default('silent'),
  VIDEO_TTS_VOICE: z.string().optional(),
  GOOGLE_TTS_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  VIDEO_BGM_PATH: z.string().optional(),
  VIDEO_STORAGE: z.enum(['local', 'supabase']).default('local'),
  VIDEO_LOCAL_DIR: z.string().default('data/videos'),
  SUPABASE_URL: z
    .string()
    .refine((v) => /^https:\/\/[^/?#\s]+\/?$/.test(v), 'must be an https origin without a path')
    .transform((v) => v.replace(/\/$/, ''))
    .optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  VIDEO_STORAGE_BUCKET: z.string().default('videos'),
  INSTAGRAM_API_BASE: z.string().default('https://graph.instagram.com/v24.0'),
  INSTAGRAM_USER_ID: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_PRIVACY: z.enum(['public', 'unlisted', 'private']).default('public'),
})

export type Config = z.infer<typeof schema>

/**
 * Cross-field checks that would otherwise only fail at publish time. Reels fetches the video from
 * a public https URL, which only the Supabase storage provides.
 */
export function videoConfigErrors(c: Config): string[] {
  const errors: string[] = []
  if (c.VIDEO_PLATFORMS.includes('reels') && c.VIDEO_STORAGE !== 'supabase') {
    errors.push('VIDEO_PLATFORMS includes reels but VIDEO_STORAGE is not supabase')
  }
  if (c.VIDEO_STORAGE === 'supabase' && (!c.SUPABASE_URL || !c.SUPABASE_SERVICE_KEY)) {
    errors.push('VIDEO_STORAGE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
  }
  return errors
}

// `KEY=` lines in .env mean "not set", not an empty value.
export const config: Config = schema.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
)
{
  const errors = videoConfigErrors(config)
  if (errors.length) throw new Error(`invalid video config: ${errors.join('; ')}`)
}

/** The dashboard runs only where its login codes can reach the owner's Telegram chat. */
export function dashboardEnabled(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID)
}

export function requireValue<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key]
  if (value === undefined || value === null || value === '') {
    throw new Error(`${key} is not set`)
  }
  return value as NonNullable<Config[K]>
}
