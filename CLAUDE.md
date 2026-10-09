# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Content Autopilot is a personal internal tool, not a SaaS. It collects AI and developer news from RSS, has an LLM pick topics and write Korean Threads posts, sends each draft to a Telegram bot for approval, and publishes approved posts at fixed time slots. The MVP covers **Threads only** and does **not use n8n**: all scheduling and retries live in this codebase on pg-boss.

Human-facing docs (Korean) live in `docs/`: `setup.md` (external services and tokens), `architecture.md`, `operations.md` (CLI, troubleshooting, deployment), `decisions.md` (why Threads-only and no n8n, plus the roadmap) and `conventions.md`. Update them when behavior they describe changes.

**Commit messages must follow `docs/conventions.md`:** `<type>: <Korean summary>`, e.g. `feat: Telegram 검수 메시지에 수정 답장 기능 추가`. The type is one of feat, fix, docs, refactor, test, chore or perf, and an optional body explains why. A commit-msg hook (`.githooks/commit-msg` → `scripts/commit-msg.mjs`, enabled by `npm install` via `prepare`) rejects non-conforming messages. Fix the message instead of bypassing the hook with `--no-verify`. Code, comments and logs stay in English; prompts, Telegram text and `docs/` are in Korean.

## Commands

```bash
npm run db:migrate        # apply migrations/*.sql (the worker also runs this on start)
npm start                 # long-running worker: pg-boss schedules + Telegram bot polling
npm run dev               # same as start, with watch mode
npm run cli -- <command>  # manual ops; run without arguments to see all commands
npm run typecheck         # tsc --noEmit (code is run by tsx; there is no build step)
npm run lint              # biome check (npm run format applies fixes)
npm test                  # vitest run (unit; test/integration is excluded)
npm run test:integration  # DB scenarios against a LOCAL Postgres only (guard in test/integration/setup.ts); CI runs it on pgvector/pgvector:pg17 with DATABASE_SSL=false
npx vitest run test/time.test.ts -t "rolls over"   # run a single test
```

Useful CLI commands:
- `collect` / `daily`: run the pipeline by hand, without the queue
- `add-topic "<title>" [url] [note]`: create a draft from a manual topic (same as Telegram `/add`)
- `show <postId>`, `approve <postId>`, `publish-now <postId>`
- `threads:check`: verify the Threads token

Config is loaded from `.env` (see `.env.example`) and validated in `src/config.ts`. An empty `KEY=` line counts as unset.

## Architecture

The pipeline is a chain of pg-boss queues, all defined in `src/jobs.ts`:

```
daily-pipeline (cron) → collect → rank (expire stale, score, flag duplicates) → enqueue generate for every SHORTLISTED topic without a post
generate-v2 {topicId, regenerate?, feedback?} (policy singleton per topic) → posts row PENDING_REVIEW → enqueue review
review {postId}           → Telegram message with approve / regen / reject buttons
  approve                 → approvePost assigns next free PUBLISH_SLOTS time → SCHEDULED
publish-due (*/5 cron)    → enqueue publish for due posts (singletonKey per post)
publish {postId}          → Threads container → wait FINISHED → threads_publish
refresh-token (daily)     → refresh the Threads long-lived token (60 days) near expiry
review-maintenance (hourly) → expire PENDING_REVIEW drafts untouched 48h (EXPIRED) + 09/18h reminders
```

Key design points that span several files:
- **The `posts` row is the source of truth for publishing, not the job.** `publishPost` claims a row with an atomic `UPDATE … status='PUBLISHING', attempts = attempts + 1, claim_seq = claim_seq + 1`. The new `claim_seq` is the claim's ownership token, and every later write is conditioned on `status='PUBLISHING' and claim_seq = token`. `attempts` is not the token because `publish-now` resets it. A worker that lost its claim to the stale-row sweep therefore writes nothing and never publishes (`LostClaimError`). It saves `container_id` before publishing and re-checks ownership right before `threads_publish`; that check doubles as a heartbeat. `driveContainer` reuses an existing container and treats `PUBLISHED` as done, so retries never double-post. On failure, `decideAfterFailure` re-checks the container so a lost response does not mark a live post `FAILED`. A partial unique index on `posts.scheduled_at` (`003`) keeps one post per slot. The `publish` queue uses `retryLimit: 0`; retries happen when `publish-due` re-finds the row (failed attempts go back to `SCHEDULED`, then `FAILED` after 3 attempts). Rows stuck in `PUBLISHING` for more than 10 minutes are treated as crashed and resumed.
- **Volume is a fixed count, not a score threshold.** `rank` sends all candidates in one LLM call and keeps the top `DAILY_POST_COUNT`. Unpicked topics become `SKIPPED`, so news does not carry over to the next day.
- **Dedupe is done by the ranker, not embeddings.** Exact URLs are blocked by `topics.url_hash`. For everything else, the rank LLM sees the candidates plus topics used in the last 14 days and returns `duplicate_of`. `resolveDuplicates` drops invalid, self and mutual references before `pickTop`. Embedding dedupe was removed (`002_drop_embedding.sql`): GeekNews Korean summaries and their HN English originals measured only 0.37–0.63 cosine, so no threshold could separate them. `rankCollected` first expires `COLLECTED` topics older than 48h.
- **LLM calls go through `chatJson`** (`src/llm/openrouter.ts`). It sends a JSON schema built from the zod schema and always re-validates the output with zod. Prompts are in Korean and live in `src/pipeline/prompts.ts`.
- **Generation is grounded in the fetched article body** (Readability + linkedom). If no body can be read, the topic is skipped (`SkipTopicError`, not retried). Transient fetch failures (429/5xx/timeouts, `TransientFetchError`) are retried instead. An initial generate reuses an existing draft and never overwrites one (`on conflict do nothing`). Regeneration goes through `enqueueRegeneration`, which bumps `posts.regen_seq`. The rewrite is applied only if that seq is still the latest and the post is PENDING_REVIEW, so a retried older request cannot clobber a newer result. Jobs on the legacy `generate` queue are forwarded to `generate-v2`. The source URL goes in `link_attachment`, never in the post text.
- **Threads access goes through the `ThreadsApi` interface.** When `THREADS_DRY_RUN=true`, `getThreadsApi()` returns `DryRunThreadsClient`. The token is seeded from env into `platform_accounts` on first use; after that, the DB copy is authoritative.
- **Telegram review.** Buttons and replies act only on the post's current `review_message_id` while it is `PENDING_REVIEW` and `review_revision = revision`. Every text change bumps `revision`, and approval passes the revision the reviewer saw to `approvePost`. `sendForReview` registers a message only if the revision it displays is still current. Sending a new review message strips the previous message's keyboard. Replying to a review message with `수정: <text>` replaces the draft verbatim. Any other reply is treated as feedback and triggers regeneration. The bot ignores every chat except `TELEGRAM_CHAT_ID`; `/start` prints the chat id. `/status` shows pipeline state (`src/pipeline/status.ts`). `/add <url> [note]` creates a manual topic whose `topics.note` (the owner's opinion) becomes the post's angle, but never a source of facts. Commands must be registered before the `message:text` handler, which ends the middleware chain for non-reply text. Without `TELEGRAM_BOT_TOKEN`, review falls back to console output plus the CLI.
- **After approval**, the confirmation message has `unsched:<id>:<epoch>` / `pubnow:<id>:<epoch>` buttons. They are bound to that exact `scheduled_at`. Un-scheduling bumps `revision` and re-sends review. Publish-now only moves `scheduled_at` to now and still goes through the sweep and claim.
- **Liveness:** `HEALTHCHECK_URL` is pinged every 5 min by `worker.ts`. `HEALTHCHECK_DAILY_URL` is pinged after each daily run, and `/fail` is pinged on its final failure. Both are optional.
- **Final-failure alerts.** `alertOnFinalFailure` in `jobs.ts` notifies Telegram when the daily, generate or review job throws on its last attempt. The retry-limit constants there are shared with `createQueue`.

## Environment notes

- **DB SSL:** `DATABASE_SSL` (default true) controls `dbSsl` in `src/db/pool.ts`, shared with pg-boss. Set it to false only for local/CI Postgres.
- **Supabase:** use the **session pooler** URL (`aws-0-ap-northeast-2.pooler.supabase.com:5432`). The direct `db.*.supabase.co` host is IPv6-only. Transaction mode (port 6543) does not suit a long-running pg-boss worker.
- **pg types:** `pg` is configured in `src/db/pool.ts` to parse `int8`/`numeric` as JS numbers.
- **Threads API:** host `graph.threads.net/v1.0`. Posts have a 500-character limit, at most 5 links, and 250 posts per 24h. The Meta app runs in development mode with the owner as a Threads tester, so no App Review is needed. Keep the profile public; private-profile grants expire after 90 days.
- **hnrss.org** returns HTTP 429 when polled repeatedly in a short window. `collectAll` isolates per-feed failures.
