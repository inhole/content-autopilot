-- Short-form videos (Instagram Reels / YouTube Shorts) made from published Threads posts
-- (docs/plans/video.md, docs/decisions.md 15). A video is reviewed once and published per
-- platform, so review state lives in videos and publishing state in video_publications.

create table videos (
  id bigserial primary key,
  post_id bigint not null unique references posts (id),
  status text not null default 'SCRIPTING'
    check (status in (
      'SCRIPTING', 'RENDERING', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED',
      'REJECTED', 'EXPIRED', 'FAILED'
    )),
  title text,
  caption text,
  hashtags text[] not null default '{}',
  -- [{ heading, narration }]; the closing source scene is added by code at render time.
  scenes jsonb,
  source_url text,
  source_label text,
  generation jsonb,
  -- Bumped on every text change; review buttons and replies only act on the revision shown.
  revision integer not null default 1,
  -- Latest script request and its feedback, kept together so a lost enqueue can be redone.
  regen_seq integer not null default 1,
  regen_feedback text,
  -- Times maintenance re-queued a stuck SCRIPTING/RENDERING stage since the last stage change.
  stage_recoveries integer not null default 0,
  -- Hash of every render input (scenes, voice, template...); equal hash = same video file.
  render_hash text,
  video_url text,
  storage_key text,
  duration_ms integer,
  size_bytes integer,
  rendered_at timestamptz,
  review_chat_id bigint,
  -- The sendVideo message carrying the buttons, and the script message sent right before it.
  review_message_id bigint,
  script_message_id bigint,
  review_revision integer,
  last_error text,
  published_at timestamptz,
  storage_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index videos_status_idx on videos (status, updated_at);

create table video_publications (
  id bigserial primary key,
  video_id bigint not null references videos (id) on delete cascade,
  platform text not null check (platform in ('REELS', 'SHORTS')),
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
  scheduled_at timestamptz not null,
  -- The platform account the owner approved for; a different account at publish time fails.
  account_user_id text,
  attempts integer not null default 0,
  -- Claim ownership token, as posts.claim_seq.
  claim_seq bigint not null default 0,
  -- Reels: container saved before publishing. Shorts: resumable session saved before uploading.
  container_id text,
  container_created_at timestamptz,
  upload_url text,
  platform_media_id text,
  permalink text,
  published_at timestamptz,
  -- Shorts: when processing was confirmed (or found failed) after the upload.
  verified_at timestamptz,
  last_error text,
  -- 'auth' | 'account' | 'session' | 'other': why the last attempt failed.
  error_kind text,
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_id, platform),
  -- One video slot per day, so this keeps one video per platform per day.
  unique (platform, scheduled_at)
);

create index video_publications_due_idx on video_publications (scheduled_at)
  where status in ('SCHEDULED', 'PUBLISHING');

-- Snapshots like post_insights; a null metric means the platform did not return it.
create table video_insights (
  id bigserial primary key,
  publication_id bigint not null references video_publications (id) on delete cascade,
  collected_at timestamptz not null default now(),
  views int,
  likes int,
  comments int,
  shares int,
  saves int
);
create index video_insights_pub_collected_idx on video_insights (publication_id, collected_at desc);

-- Instagram and YouTube tokens live next to the Threads one. YouTube keeps a refresh token and
-- short-lived access tokens.
alter table platform_accounts drop constraint platform_accounts_platform_check;
alter table platform_accounts add constraint platform_accounts_platform_check
  check (platform in ('THREADS', 'INSTAGRAM', 'YOUTUBE'));
alter table platform_accounts add column refresh_token text;
