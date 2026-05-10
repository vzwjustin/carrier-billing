-- H8 + H9 + H10 — Stripe webhook hardening.
--
-- H8: Webhook handler errors were silently ack'd → Stripe never retried →
--     paying customers could miss entitlement. Fix: track per-event processing
--     state so the route can return 5xx on failure (Stripe will retry) and an
--     out-of-band cron can replay still-failed events.
--
-- H9: Out-of-order subscription events could resurrect canceled subscriptions
--     (a delayed `customer.subscription.updated` overwriting a later
--     `customer.subscription.deleted`). Fix: track the latest applied
--     subscription event timestamp on the profile so handlers can refuse
--     stale events.
--
-- H10: Code/comment drift — the handler claimed it threw to make Stripe retry
--      but the route catch-all returned 200. With H8 the comment now matches
--      reality.
--
-- All columns are additive + nullable; existing rows are unaffected. Safe to
-- apply forward-only with no backfill.

-- ----------------------------------------------------------------------------
-- billing_events: per-event processing state
-- ----------------------------------------------------------------------------
alter table public.billing_events
  add column if not exists processed_at timestamptz,
  add column if not exists processed_status text,
  add column if not exists last_error text,
  add column if not exists last_attempted_at timestamptz;

-- Restrict processed_status to known values. NULL means "not yet attempted".
alter table public.billing_events
  drop constraint if exists billing_events_processed_status_check;
alter table public.billing_events
  add constraint billing_events_processed_status_check
    check (processed_status is null or processed_status in ('success', 'failed'));

-- Replay cron predicate is "unprocessed or failed within 24h, not in cooldown".
-- A partial index keeps the scan cheap regardless of how big the table grows.
create index if not exists billing_events_replay_idx
  on public.billing_events(created_at)
  where processed_status is null or processed_status = 'failed';

-- ----------------------------------------------------------------------------
-- profiles: latest subscription event timestamp (Stripe `event.created`)
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists subscription_event_at timestamptz;
