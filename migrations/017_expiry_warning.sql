-- When the "expires soon" warning was sent for a draft. Deliberately separate from updated_at:
-- updated_at is the draft's last touch and drives its 48h life, so recording a warning there
-- would extend it. A draft is warned again only after a later touch (expiry_warned_at < updated_at).
alter table posts add column if not exists expiry_warned_at timestamptz;
