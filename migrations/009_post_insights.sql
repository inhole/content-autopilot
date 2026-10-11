-- Per-post Threads engagement numbers, one row per collection. Counts keep growing for days after
-- publishing, so snapshots (instead of one overwritten row) let the weekly report use the latest
-- value and still show growth later. A null metric means Threads did not return it, not zero.
create table post_insights (
  id bigserial primary key,
  post_id bigint not null references posts(id) on delete cascade,
  collected_at timestamptz not null default now(),
  views int,
  likes int,
  replies int,
  reposts int,
  quotes int,
  shares int
);
create index post_insights_post_collected_idx on post_insights (post_id, collected_at desc);
