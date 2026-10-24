-- The campaign profile saved from the web console (one row). When present it wins over
-- config/campaign-profile.json; deleting the row brings the file back. `revision` guards edits:
-- a save or reset must carry the revision the page displayed.
create table campaign_profile (
  id smallint primary key default 1 check (id = 1),
  profile jsonb not null,
  revision int not null,
  updated_at timestamptz not null default now()
);
