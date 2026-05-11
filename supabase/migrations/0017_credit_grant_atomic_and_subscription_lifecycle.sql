-- 0017 — Atomic credit-grant flag + subscription lifecycle UX fields.
--
-- C1 — Permanent credit loss on first-attempt RPC failure.
--   The previous design gated `increment_audit_credits` on
--   `previousStatus IS NULL`. If the very first RPC call failed (DB hiccup),
--   the billing_events row was written with `processed_status='failed'`,
--   and every subsequent Stripe retry + replay-cron run saw a non-null
--   previousStatus → the credit grant was permanently skipped. A paying
--   one-time customer ($149) silently received nothing.
--
--   Fix: tie the grant to a per-event boolean flag (`credit_granted`).
--   `grant_credit_once` atomically flips the flag and increments the
--   profile balance in a single PL/pgSQL block. Retries can attempt the
--   grant until the flag flips; once flipped, subsequent attempts no-op.
--
-- H6 — `cancel_at_period_end` not surfaced in product UI.
--   Stripe's `subscription.cancel_at_period_end=true` keeps the user
--   `subscription_status='active'` until period end. Without local state
--   for that transition, /settings/billing can't tell the user "your
--   access ends on YYYY-MM-DD" — driving avoidable support tickets.
--
--   Fix: persist the two fields read from Stripe Subscription objects.
--   Additive + nullable; no backfill required.
--
-- All changes are forward-only and safe to apply without downtime.

-- ----------------------------------------------------------------------------
-- C1: billing_events.credit_granted
-- ----------------------------------------------------------------------------
alter table public.billing_events
  add column if not exists credit_granted boolean not null default false;

-- ----------------------------------------------------------------------------
-- H6: profiles cancellation lifecycle fields
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists current_period_end timestamptz;

-- ----------------------------------------------------------------------------
-- C1: atomic grant-once RPC.
--
-- Contract: returns TRUE if this call granted the credit, FALSE if a prior
-- call already did. Both branches are safe for the caller to treat as
-- "credit is now applied" — only the boolean tells you whether THIS call
-- mutated state.
--
-- Atomicity: the conditional UPDATE on billing_events is the gate. ROW_COUNT
-- after that UPDATE distinguishes "we won the race" (1) from "already
-- granted" (0). Both UPDATEs run in the calling transaction, so a failure
-- between them rolls back atomically — the flag never flips without the
-- balance moving with it.
--
-- SECURITY DEFINER: matches `increment_audit_credits`. Service-role only.
-- ----------------------------------------------------------------------------
create or replace function public.grant_credit_once(
  p_event_id uuid,
  p_profile_id uuid,
  p_delta int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed int;
begin
  if p_delta <= 0 then
    raise exception 'grant_credit_once: p_delta must be positive (got %)', p_delta;
  end if;

  update public.billing_events
     set credit_granted = true
   where id = p_event_id
     and credit_granted = false;

  get diagnostics v_changed = row_count;
  if v_changed = 0 then
    return false; -- prior call already granted; idempotent no-op.
  end if;

  update public.profiles
     set audit_credits = audit_credits + p_delta,
         updated_at = now()
   where id = p_profile_id;

  if not found then
    -- Profile vanished between checkout and the grant. Roll back the
    -- credit_granted flag by raising; the calling transaction unwinds and
    -- a future retry will re-attempt.
    raise exception 'grant_credit_once: profile % not found', p_profile_id;
  end if;

  return true;
end;
$$;

revoke all on function public.grant_credit_once(uuid, uuid, int) from public;
grant execute on function public.grant_credit_once(uuid, uuid, int) to service_role;
