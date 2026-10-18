-- Kakao gift trial campaigns (카카오톡 선물하기 체험단, docs/plans/campaign-autopilot.md). The
-- public list API gives title, brand, product, remaining days and applicant counts; applying and
-- writing the review only work in the KakaoTalk mobile app, so the owner does both by hand and
-- records each step with a Telegram button. A campaign row is the source of truth for that state.
create table campaigns (
  id bigserial primary key,
  source text not null default 'kakao-gift',
  external_id text not null,
  url text not null,
  url_hash text not null unique,
  status text not null default 'COLLECTED' check (status in (
    'COLLECTED', 'SKIPPED', 'SHORTLISTED', 'PENDING_REVIEW', 'REJECTED', 'EXPIRED',
    'APPLIED', 'SELECTED', 'NOT_SELECTED', 'DRAFT_REVIEW', 'POSTED'
  )),

  -- From the public list (src/campaigns/gift.ts), refreshed on every collection.
  title text not null,
  brand text,
  product_id bigint,
  image_url text,
  recruit_count integer,
  application_count integer,
  remaining_days integer,
  -- Estimated from remaining_days: the end of that KST day.
  apply_deadline timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- The raw list item as last seen.
  detail jsonb,

  -- Ranking (src/campaigns/rank.ts).
  score numeric,
  reason text,
  skip_reason text,

  -- Telegram card. revision is bumped on every change the owner sees, and buttons carry the
  -- revision they were created for.
  revision integer not null default 0,
  review_chat_id bigint,
  review_message_id bigint,
  review_revision integer,
  reject_reason text,

  applied_at timestamptz,
  selected_at timestamptz,
  result_at timestamptz,
  -- Set by the owner with /due; drives the review reminders.
  review_deadline timestamptz,

  -- Gift review draft. intake_message_id is the Telegram message the owner replies to with a memo.
  -- regen_seq orders draft regenerations like posts.regen_seq.
  intake_message_id bigint,
  memo text,
  draft_text text,
  regen_seq integer not null default 0,
  posted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);

create index campaigns_status_idx on campaigns (status);
create index campaigns_review_message_idx on campaigns (review_message_id) where review_message_id is not null;
create index campaigns_intake_message_idx on campaigns (intake_message_id) where intake_message_id is not null;

-- One row per reminder sent (kind such as 'review-d3'), so each goes out once.
create table campaign_reminders (
  campaign_id bigint not null references campaigns (id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (campaign_id, kind)
);
