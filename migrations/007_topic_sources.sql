-- Discussion page of a topic (e.g. the Hacker News thread from the RSS item's <comments>), used to
-- fetch top comments as extra "how developers reacted" context when drafting. Null when the
-- source has no discussion.
alter table topics add column discussion_url text;
