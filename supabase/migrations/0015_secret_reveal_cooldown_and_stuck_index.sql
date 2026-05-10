-- 0015 — secret-reveal cooldown column + stuck-in-flight index.
--
-- Two unrelated launch-hardening followups bundled into a single forward-only
-- migration:
--
-- 1. (advisor R2-F5) `copyOutboundWebhookSecretAction` had no rate limit.
--    Adds `last_secret_reveal_at` so the action can enforce a per-user cooldown
--    on plaintext-secret retrieval. 1-call/sec cap (~60/min/user). Lightweight
--    defense against post-XSS or session-hijack repeated-call exfiltration.
--    Per-row, no new infra; can be replaced with Upstash later without losing
--    the column.
--
-- 2. (advisor R1-F4) The 0014 partial index `billing_events_replay_idx`
--    deliberately excludes `in_flight` rows so the normal replay path stays
--    efficient. But the cron's `stuckInFlightQuery` selects exactly those
--    rows for stuck-claim recovery, and the existing index doesn't cover it,
--    so the query did a filtered seqscan. This partial index gives the
--    stuck-recovery path its own index.

alter table public.profiles
  add column if not exists last_secret_reveal_at timestamptz;

create index if not exists billing_events_stuck_in_flight_idx
  on public.billing_events(created_at)
  where processed_status = 'in_flight';
