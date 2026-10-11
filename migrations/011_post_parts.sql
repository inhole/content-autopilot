-- Follow-up parts of a thread chain (docs/decisions.md 8). The main post stays in posts and is
-- part 1; parts 2 and 3 are the owner's own replies published after it, each replying to the
-- previous part. A part is claimed like a post: claim_seq is the ownership token and container_id
-- is saved before publishing, so a retry never posts the same part twice. alerted_at records that
-- the owner was told about a FAILED part; until then the publish-due sweep keeps re-sending the
-- alert, so a crash or Telegram outage cannot lose the only way back (the retry button).
create table post_parts (
  post_id bigint not null references posts (id) on delete cascade,
  idx smallint not null check (idx in (2, 3)),
  text text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
  container_id text,
  platform_post_id text,
  attempts integer not null default 0,
  claim_seq bigint not null default 0,
  last_error text,
  published_at timestamptz,
  alerted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (post_id, idx)
);

create index post_parts_unfinished_idx on post_parts (post_id) where status in ('PENDING', 'PUBLISHING');
