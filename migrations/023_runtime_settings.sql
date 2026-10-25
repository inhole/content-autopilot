-- Schedules and volumes saved from the web console (one row). When `settings` is set it wins over
-- the env values (COLLECT_CRON, GIFT_COLLECT_CRON, MUSINSA_COLLECT_CRON, DAILY_POST_COUNT,
-- PUBLISH_SLOTS, CAMPAIGN_DAILY_MAX); a reset clears it (null) so env applies again. `revision`
-- guards edits (a save or reset must carry the revision the page displayed) and only ever grows,
-- also across resets, so a page that saw an older copy can never match a newer one.
create table runtime_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb,
  revision int not null,
  updated_at timestamptz not null default now()
);
