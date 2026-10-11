-- Which part of a thread chain a reader's reply answers: null for the main post, otherwise the
-- post_parts idx. Replies under follow-up parts are polled too, and the notification says where
-- the reply was left. The owner's answer still goes to the reader's reply itself (its id).
alter table threads_replies add column part_idx smallint;
