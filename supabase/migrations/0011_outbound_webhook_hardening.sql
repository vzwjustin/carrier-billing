-- Outbound webhook + inbound dedupe hardening.
--
-- Companion to the application-level changes in this migration's PR:
--
--   * Outbound dispatcher switched to a Stripe-style timestamped HMAC-SHA256
--     signature (v2 scheme). No DB schema change required for that — the
--     existing `outbound_webhook_secret` column is reused. M-W6 (encrypting
--     the secret at rest via pgsodium) is intentionally deferred to a
--     follow-up; tracked separately.
--
--   * Inbound dedupe key changed from `sha256(rawBody)` to a stable triple
--     `sha256(${userId}|${pdfSha256}|${normalizedFilename})`. The column
--     remains a generic `event_hash text not null unique`, so we don't need
--     to alter the schema — but we DO need to clear any stale legacy hashes
--     to avoid false-positive dedupe hits against old rows.

-- Drop legacy raw-body hashes. They cannot collide with the new content-key
-- hashes (different inputs), but the row is also useless once the migration
-- ships, and keeping it around risks confusion in incident debugging. The
-- `event_hash` is opaque so we have no schema-level way to tell them apart
-- — clear the table entirely. Dedupe is a deliverability nicety, not a
-- correctness invariant; losing a few hours of dedupe history is fine.
truncate table public.inbound_email_events;

-- Defense-in-depth: enforce that webhook URLs cannot be saved with an http://
-- scheme even at the column level. (App-level validation in
-- src/app/(app)/settings/actions.ts also performs full SSRF checks.)
alter table public.profiles
  drop constraint if exists profiles_outbound_webhook_url_check;
alter table public.profiles
  add constraint profiles_outbound_webhook_url_check
  check (
    outbound_webhook_url is null
    or outbound_webhook_url ~* '^https://[^[:space:]]+$'
  );
