create extension if not exists vector;

create table sources (
  id bigserial primary key,
  kind text not null default 'RSS' check (kind in ('RSS', 'MANUAL')),
  name text not null,
  url text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table topics (
  id bigserial primary key,
  source_id bigint references sources (id),
  title text not null,
  url text,
  -- sha256 of the normalized URL; null for manual topics without a URL
  url_hash text unique,
  feed_summary text,
  published_at timestamptz,
  embedding vector(1536),
  score numeric,
  score_reason text,
  duplicate_of bigint references topics (id),
  status text not null default 'COLLECTED'
    check (status in ('COLLECTED', 'SHORTLISTED', 'USED', 'SKIPPED', 'DUPLICATE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index topics_status_created_idx on topics (status, created_at desc);

create table posts (
  id bigserial primary key,
  topic_id bigint not null references topics (id),
  platform text not null default 'THREADS' check (platform in ('THREADS')),
  text text not null,
  angle text,
  source_url text,
  generation jsonb,
  status text not null default 'PENDING_REVIEW'
    check (status in (
      'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'REJECTED'
    )),
  review_chat_id bigint,
  review_message_id bigint,
  scheduled_at timestamptz,
  -- Saved before calling publish so a retry resumes instead of double-posting.
  container_id text,
  platform_post_id text,
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic_id, platform)
);

create index posts_due_idx on posts (scheduled_at) where status = 'SCHEDULED';

create table platform_accounts (
  platform text primary key check (platform in ('THREADS')),
  user_id text not null,
  access_token text not null,
  expires_at timestamptz,
  refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into sources (kind, name, url) values
  ('MANUAL', 'Manual', 'manual://'),
  ('RSS', 'GeekNews', 'https://news.hada.io/rss/news'),
  ('RSS', 'Hacker News (100+ points)', 'https://hnrss.org/frontpage?points=100');
