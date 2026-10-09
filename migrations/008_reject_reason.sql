-- Why a draft was discarded. The style prompt turns the dominant reasons into guidance for the
-- next drafts (e.g. many 'boring' -> make the hook concrete). Null for rejections made before this
-- column existed or via the CLI. Codes mirror REJECT_REASONS in src/pipeline/style.ts.
alter table posts add column reject_reason text
  check (reject_reason is null or reject_reason in ('fact', 'boring', 'topic', 'dup', 'other'));
