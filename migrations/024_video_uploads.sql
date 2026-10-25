-- Owner-made videos uploaded through the admin console (docs/plans/video-upload.md). An upload
-- has no post: it starts as UPLOADING (row, no file) and joins the normal review from
-- PENDING_REVIEW on.

alter table videos alter column post_id drop not null;
alter table videos add column origin text not null default 'generated'
  check (origin in ('generated', 'upload'));
alter table videos add constraint videos_origin_post_check
  check (origin = 'upload' or post_id is not null);

alter table videos drop constraint videos_status_check;
alter table videos add constraint videos_status_check
  check (status in (
    'UPLOADING', 'SCRIPTING', 'RENDERING', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED',
    'REJECTED', 'EXPIRED', 'FAILED'
  ));

-- When the latest file request started: an upload in progress is never expired under it.
alter table videos add column upload_started_at timestamptz;
alter table videos add column original_name text;
-- Display size (rotation applied); renders fill in 1080x1920.
alter table videos add column width integer;
alter table videos add column height integer;
update videos set width = 1080, height = 1920 where video_url is not null;

-- A publication the owner gave up on (a final failure). The video is finished once every
-- publication is PUBLISHED or CANCELLED.
alter table video_publications drop constraint video_publications_status_check;
alter table video_publications add constraint video_publications_status_check
  check (status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'));

-- Storage keys written before the upload. The file request deletes its row (reclaiming = false)
-- in the transaction that references the key; a row left behind is an attempt with an unknown
-- outcome, reclaimed by video-cleanup.
create table video_upload_attempts (
  key text primary key,
  video_id bigint not null,
  reclaiming boolean not null default false,
  created_at timestamptz not null default now()
);
