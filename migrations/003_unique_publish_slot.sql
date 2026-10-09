-- Two concurrent approvals (Telegram and CLI) could read the same free slot and both schedule
-- it. A partial unique index makes the second one fail so approvePost can pick another slot.
create unique index if not exists posts_unique_publish_slot
  on posts (scheduled_at)
  where status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED');
