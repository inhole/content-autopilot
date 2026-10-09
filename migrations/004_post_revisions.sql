-- revision: bumped on every text change. A review message is only actionable for the revision it
-- displayed (review_revision), so stale buttons cannot approve text the reviewer has not read.
alter table posts add column revision integer not null default 1;
alter table posts add column review_revision integer;
update posts set review_revision = revision where review_message_id is not null;

-- regen_seq: number of the latest regeneration request. A retried older request must not
-- overwrite the result of a newer one.
alter table posts add column regen_seq integer not null default 0;

-- claim_seq: publish claim ownership token. Unlike attempts it is never reset (publish-now resets
-- attempts), so a stale worker can never hold a token that matches a newer claim.
alter table posts add column claim_seq bigint not null default 0;
