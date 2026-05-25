-- 0028 — Monthly audit digest email.
--
-- Adds three columns to `profiles`:
--   * digest_opt_out          — operator-facing opt-out flag (toggled from
--                               /settings/digest UI). When TRUE the cron skips
--                               the user entirely. Default FALSE so existing
--                               users are opted-in by default (subject to the
--                               25-day window + "has-completed-audit" gate
--                               enforced in the Inngest function).
--   * digest_last_sent_at     — last time we successfully sent a digest. The
--                               cron uses `< now() - interval '25 days'` (or
--                               NULL) to decide who's due.
--   * digest_unsub_token      — opaque 24-byte base64url token (32 chars)
--                               minted lazily on first digest send. Carried as
--                               `?token=<...>` in the unsubscribe link so the
--                               public GET route can flip `digest_opt_out=true`
--                               without authentication.
--
-- A partial unique index protects against duplicate tokens — collision is
-- astronomically unlikely (192 bits) but the index guarantees the property
-- regardless of how tokens get generated. Only the non-null subset is indexed
-- so NULL is preserved as the "no token minted yet" sentinel.
--
-- RLS is unchanged. `digest_opt_out` is readable + writable to the owner via
-- the existing `"own profile read"` / `"own profile update"` policies. The
-- token is service-role-only (no policy needed because the public unsubscribe
-- route uses the admin client to flip the flag).
--
-- Forward-only and additive. No backfill required.

alter table public.profiles
  add column if not exists digest_opt_out boolean not null default false,
  add column if not exists digest_last_sent_at timestamptz,
  add column if not exists digest_unsub_token text;

create unique index if not exists profiles_digest_unsub_token_uniq
  on public.profiles(digest_unsub_token)
  where digest_unsub_token is not null;
