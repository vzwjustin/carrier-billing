-- Inbound email ingest + outbound webhook columns on profiles.
--
-- - `inbound_email_token`: per-user opaque token used as the local-part suffix
--   for forwarded bills (e.g. `bills+<token>@inbound.<domain>`). Generated on
--   demand by the app via `gen_inbound_email_token()` so we can revoke + rotate
--   without a separate table. UNIQUE so collisions are impossible.
-- - `outbound_webhook_url` / `outbound_webhook_secret`: optional user-supplied
--   destination for `audit.completed` POSTs, signed with HMAC-SHA256 of the
--   request body using the per-user secret. NULL means no webhook configured.

alter table public.profiles
  add column if not exists inbound_email_token text,
  add column if not exists outbound_webhook_url text,
  add column if not exists outbound_webhook_secret text;

-- Token must be unique across all users (so an inbound recipient address
-- resolves to exactly one user). NULL allowed because not every profile has
-- one until they visit /settings.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'profiles_inbound_email_token_key'
  ) then
    create unique index profiles_inbound_email_token_key
      on public.profiles (inbound_email_token)
      where inbound_email_token is not null;
  end if;
end $$;

-- Webhook URL must be https or null. Avoids accidental http:// drops in plain
-- text and keeps the surface defensive.
alter table public.profiles
  drop constraint if exists profiles_outbound_webhook_url_check;
alter table public.profiles
  add constraint profiles_outbound_webhook_url_check
  check (
    outbound_webhook_url is null
    or outbound_webhook_url like 'https://%'
  );
