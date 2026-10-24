-- The campaign profile saved from the web console (one row). When `profile` is set it wins over
-- config/campaign-profile.json; a reset clears it (null) so the file applies again. `revision`
-- guards edits (a save or reset must carry the revision the page displayed) and only ever grows,
-- also across resets, so a page that saw an older copy can never match a newer one.
create table campaign_profile (
  id smallint primary key default 1 check (id = 1),
  profile jsonb,
  revision int not null,
  updated_at timestamptz not null default now()
);
