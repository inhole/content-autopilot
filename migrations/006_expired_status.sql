-- EXPIRED: drafts nobody reviewed in time. Without it they would pile up in PENDING_REVIEW and
-- stale news could still be approved days later.
-- 001 declared the check inline and unnamed, so Postgres named it posts_status_check.
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (status in (
  'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'REJECTED',
  'EXPIRED'
));
