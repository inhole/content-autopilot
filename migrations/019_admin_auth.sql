-- Admin console login (docs/dashboard.md): one-time codes sent to the owner's Telegram chat,
-- server-side sessions behind an HttpOnly cookie, and an audit log of every admin action.

create table admin_login_codes (
  id bigserial primary key,
  -- sha256 of the 6-digit code; the code itself is only ever in the Telegram message.
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  ip text
);
create index admin_login_codes_created_idx on admin_login_codes (created_at desc);

create table admin_sessions (
  id bigserial primary key,
  -- sha256 of the cookie token; the token itself is only in the browser.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text
);

create table admin_actions (
  id bigserial primary key,
  at timestamptz not null default now(),
  session_id bigint references admin_sessions(id) on delete set null,
  action text not null,
  target text,
  result text not null,
  ip text,
  detail jsonb
);
create index admin_actions_at_idx on admin_actions (at desc);
create index admin_actions_action_idx on admin_actions (action, result, at desc);
