-- 0029 — Inbound finding-status webhook token.
--
-- Adds a per-user opaque token that authenticates external callers (Slack
-- bots, Linear workflows, etc.) when they POST a finding status change back
-- into CarrierAudit via `/api/inbound/finding-status`.
--
-- This is intentionally a SEPARATE column from `inbound_email_token`:
--   * Different surface area (HTTP webhook vs email forwarding address) and
--     different revocation profile (a leaked HTTP token is much more
--     dangerous than a leaked forwarding address, so operators may want to
--     rotate them independently).
--   * Different format (32-char base64url, 192 bits of entropy) vs the email
--     token's 16-char base32 (80 bits). Email tokens live in MIME headers and
--     mailbox logs; HTTP tokens only ever cross TLS, so we can afford the
--     wider keyspace without ergonomic cost.
--
-- The unique partial index keeps NULL allowed (most profiles will not have
-- a token until they explicitly mint one in /settings/integrations) while
-- guaranteeing token → user is a 1:1 lookup.

alter table public.profiles
  add column if not exists inbound_webhook_token text;

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'profiles_inbound_webhook_token_key'
  ) then
    create unique index profiles_inbound_webhook_token_key
      on public.profiles (inbound_webhook_token)
      where inbound_webhook_token is not null;
  end if;
end $$;

-- Defense-in-depth: 32-char base64url tokens only. Application code mints
-- them via `randomBytes(24).toString('base64url')`, so any value with a
-- different shape was inserted by some other path and should be rejected.
alter table public.profiles
  drop constraint if exists profiles_inbound_webhook_token_format;
alter table public.profiles
  add constraint profiles_inbound_webhook_token_format
  check (
    inbound_webhook_token is null
    or inbound_webhook_token ~ '^[A-Za-z0-9_-]{32}$'
  );
