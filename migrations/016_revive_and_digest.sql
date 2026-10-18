-- Second life for expired drafts (docs/plans/roadmap.md 1). origin tells where a post came from:
-- 'news' is the normal pipeline, 'revived' an expired evergreen draft sent back to review with
-- only its time-bound wording rewritten, 'digest' the weekly "이번 주 놓친 소식" chain built from
-- expired drafts. The review message shows it as a label.
alter table posts add column origin text not null default 'news'
  check (origin in ('news', 'revived', 'digest'));

-- The LLM's verdict on an expired draft: still worth reading as is ('evergreen', revive it) or
-- tied to its moment ('stale', leave it for the weekly digest). Judged once, kept for the list.
alter table posts add column revive_verdict text check (revive_verdict in ('evergreen', 'stale'));
alter table posts add column revive_reason text;
alter table posts add column revive_checked_at timestamptz;
alter table posts add column revived_at timestamptz;

-- The digest post an expired draft was folded into, so a draft is used at most once.
alter table posts add column digest_post_id bigint references posts (id);

-- A part's own link_attachment. Only digest chains set it (each item links its own source);
-- otherwise the post's source_url goes on the last part (docs/decisions.md 8).
alter table post_parts add column link_url text;

create index posts_expired_idx on posts (created_at desc) where status = 'EXPIRED';
