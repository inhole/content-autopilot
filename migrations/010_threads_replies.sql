-- Replies to our published Threads posts, forwarded to Telegram so the owner can answer quickly
-- (early reply activity drives reach). The primary key makes polling idempotent: only a reply
-- inserted for the first time is notified. telegram_message_id maps a Telegram reply-to message
-- back to the Threads reply. answer_state is the claim that keeps an answer from being posted
-- twice: ANSWERING while the Threads call runs, ANSWERED afterwards, null when it may be tried.
-- answer_container_id is saved before publishing, so a lost publish response is reconciled by
-- checking the container instead of posting again. The *_claimed_at columns let a claim left
-- behind by a crashed process expire and be taken over.
create table threads_replies (
  id text primary key,
  post_id bigint not null references posts(id),
  username text,
  text text,
  replied_at timestamptz,
  permalink text,
  notify_claimed_at timestamptz,
  notified_at timestamptz,
  telegram_message_id bigint,
  answer_text text,
  answer_claimed_at timestamptz,
  answer_container_id text,
  answer_media_id text,
  answer_state text check (answer_state is null or answer_state in ('ANSWERING', 'ANSWERED')),
  created_at timestamptz not null default now()
);

create unique index threads_replies_telegram_message_id_key
  on threads_replies (telegram_message_id) where telegram_message_id is not null;
create index threads_replies_post_id_idx on threads_replies (post_id);
