-- Fingerprint of the content a post's container was created for (text, link, topic tag). A draft
-- can go back to review after a failed attempt left a container behind (un-schedule, then edit);
-- that container must not be published with the old content. A mismatch means: check whether the
-- old container went out (lost response) and otherwise create a new one. Null (legacy) is treated
-- as a mismatch, which only costs a fresh container.
alter table posts add column container_fingerprint text;
