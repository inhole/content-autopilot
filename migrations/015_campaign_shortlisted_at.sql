-- When the ranker picked a campaign. The daily pick quota counts this instead of updated_at, which
-- also moves when hourly maintenance expires campaigns that were never picked.
alter table campaigns add column shortlisted_at timestamptz;

create index campaigns_shortlisted_at_idx on campaigns (source, shortlisted_at) where shortlisted_at is not null;
