-- M-1+M-2 — billing_events in_flight intermediate state.
--
-- Problem: markAttempt recorded last_attempted_at but not that the handler was
-- in-flight. A webhook delivery >60s let the replay cron pick up the same row,
-- both ran the handler concurrently. The credit grant was safe only because the
-- cron hardcoded previousStatus='failed' — fragile against future non-idempotent
-- ops.
--
-- Fix: introduce 'in_flight' as an intermediate processed_status. The webhook
-- route sets it before invoking handleStripeEvent; the replay cron excludes
-- in_flight rows from its candidate scan. On success → 'success'; on failure
-- → 'failed'. A concurrent attempt sees processed_status='in_flight' (non-null)
-- and the credit grant guard short-circuits.
--
-- Forward-only. Existing rows are unaffected (processed_status is still nullable).

-- Extend the processed_status domain to include 'in_flight'.
alter table public.billing_events
  drop constraint if exists billing_events_processed_status_check;
alter table public.billing_events
  add constraint billing_events_processed_status_check
    check (processed_status is null or processed_status in ('success', 'failed', 'in_flight'));

-- Update the replay partial index to exclude in_flight rows so the cron does
-- not attempt to pick up rows another worker is actively processing.
drop index if exists billing_events_replay_idx;
create index billing_events_replay_idx
  on public.billing_events(created_at)
  where processed_status is null or processed_status = 'failed';
