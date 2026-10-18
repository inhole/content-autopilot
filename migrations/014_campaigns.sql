-- Review-campaign (체험단) pipeline (docs/plans/campaign-autopilot.md). A campaign row is the
-- source of truth for every stage, like posts for Threads: steps that leave a trace outside
-- (applying on revu, saving a Naver blog draft) claim the row with claim_seq as the ownership
-- token, so a retried job never applies or saves twice.
create table campaigns (
  id bigserial primary key,
  source text not null default 'revu',
  external_id text not null,
  url text not null,
  url_hash text not null unique,
  -- Chat room the link was first seen in; null for links added by hand (/camp, CLI).
  found_in text,
  status text not null default 'DISCOVERED' check (status in (
    'DISCOVERED', 'DETAILED', 'UNREADABLE', 'SKIPPED', 'SHORTLISTED', 'PENDING_REVIEW',
    'REJECTED', 'EXPIRED', 'APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED',
    'SELECTED', 'NOT_SELECTED', 'RECEIVED', 'DRAFT_REVIEW', 'DRAFT_APPROVED',
    'DRAFT_SAVING', 'DRAFT_SAVED', 'DRAFT_FAILED', 'POSTED'
  )),

  -- Parsed detail (src/campaigns/revu.ts). detail keeps the full structured result.
  title text,
  type text check (type in ('delivery', 'visit', 'other')),
  category text,
  reward_won integer,
  recruit_count integer,
  apply_deadline timestamptz,
  announce_at timestamptz,
  review_deadline timestamptz,
  keywords text[] not null default '{}',
  detail jsonb,

  -- Ranking (src/campaigns/rank.ts).
  score numeric,
  reason text,
  skip_reason text,
  apply_message text,

  -- Telegram card. revision is bumped on every change the owner sees (apply message edit, new
  -- draft), and buttons carry the revision they were created for.
  revision integer not null default 0,
  review_chat_id bigint,
  review_message_id bigint,
  review_revision integer,
  reject_reason text,

  -- Claimed steps (apply, blog save). attempts resets when the owner presses retry.
  claim_seq bigint not null default 0,
  attempts integer not null default 0,
  last_error text,
  screenshot_path text,

  applied_at timestamptz,
  selected_at timestamptz,
  received_at timestamptz,

  -- Blog review (Phase 4). intake_message_id is the Telegram message the owner replies to with
  -- photos and a memo. regen_seq orders draft regenerations like posts.regen_seq.
  intake_message_id bigint,
  memo text,
  draft_title text,
  draft_body text,
  regen_seq integer not null default 0,
  draft_saved_at timestamptz,
  blog_url text,
  posted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);

create index campaigns_status_idx on campaigns (status);
create index campaigns_review_message_idx on campaigns (review_message_id) where review_message_id is not null;
create index campaigns_intake_message_idx on campaigns (intake_message_id) where intake_message_id is not null;

-- KakaoTalk messages already read, so the next read of a room only handles new ones.
create table kakao_messages (
  hash text primary key,
  room text not null,
  body text not null,
  seen_at timestamptz not null default now()
);

-- Photos the owner sent for a blog review. Telegram keeps the file; the local worker downloads
-- it to local_path because Aside uploads from disk.
create table campaign_photos (
  campaign_id bigint not null references campaigns (id) on delete cascade,
  idx smallint not null,
  file_id text not null,
  file_unique_id text not null,
  local_path text,
  created_at timestamptz not null default now(),
  primary key (campaign_id, idx),
  unique (campaign_id, file_unique_id)
);

-- One row per reminder sent (kind such as 'review-d3'), so each goes out once.
create table campaign_reminders (
  campaign_id bigint not null references campaigns (id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (campaign_id, kind)
);

-- Heartbeat of the local worker (Kakao + Aside), shown in /status.
create table worker_heartbeats (
  role text primary key,
  seen_at timestamptz not null default now()
);
