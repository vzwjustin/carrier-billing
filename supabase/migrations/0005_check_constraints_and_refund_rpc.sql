-- Phase 4 hardening: defensive CHECK constraints + atomic orphan-audit refund RPC.
--
-- D1: Add CHECK constraints to enforce documented value sets at the DB level.
--     Application code already enforces these via Zod / discriminated unions, but
--     the DB is the last line of defense if a code path forgets to validate.
-- D2: Index findings(rule_id) — rule-level analytics queries (e.g. "how many
--     findings did <rule_id> produce across all audits?") were doing seq scans.
-- B4: Atomic refund RPC for cleanup-orphan-audits — replaces a two-step
--     "increment_audit_credits then update audits" pattern that could leak a
--     credit if the second step failed after the first succeeded.
--     The RPC flips status -> 'failed' first (idempotency guard) and only
--     refunds the credit if that flip actually happened. A single statement
--     block — no partial state on retry.

-- ----------------------------------------------------------------------------
-- D1: CHECK constraints
-- ----------------------------------------------------------------------------

alter table public.audits
  add constraint audits_status_check
    check (status in ('pending','extracting','analyzing','completed','failed'));

alter table public.audits
  add constraint audits_carrier_check
    check (carrier is null or carrier in ('verizon','att','tmobile','unknown'));

alter table public.findings
  add constraint findings_severity_check
    check (severity in ('high','medium','low','info'));

alter table public.findings
  add constraint findings_confidence_check
    check (confidence >= 0 and confidence <= 1);

alter table public.profiles
  add constraint profiles_subscription_status_check
    check (subscription_status is null
      or subscription_status in ('active','trialing','past_due','canceled','incomplete','incomplete_expired','unpaid','paused'));

-- ----------------------------------------------------------------------------
-- D2: findings(rule_id) index
-- ----------------------------------------------------------------------------

create index if not exists findings_rule_id_idx on public.findings(rule_id);

-- ----------------------------------------------------------------------------
-- B4: refund_orphan_audit(p_audit_id, p_user_id, p_reason)
-- ----------------------------------------------------------------------------
-- Atomic refund-and-fail for the cleanup-orphan-audits cron.
--
-- Idempotency: the status flip is gated on `status = 'pending'`. If a
-- concurrent /start request already advanced the row (e.g. to 'extracting'),
-- the UPDATE matches zero rows, NOT FOUND fires, and we return without
-- refunding the credit. Subsequent runs of the cron also no-op for the same
-- reason — the row is no longer in 'pending'.
--
-- Atomicity: both UPDATEs run inside a single PL/pgSQL block, which executes
-- as a single statement from the caller's perspective and is implicitly
-- wrapped in the calling transaction (or a fresh one if the caller is
-- autocommitting). The credit refund cannot happen unless the status flip
-- did.
--
-- SECURITY DEFINER: matches `increment_audit_credits` — lets the service-role
-- caller bypass RLS while keeping the surface area minimal (this function only
-- mutates the two rows identified by the args).

create or replace function public.refund_orphan_audit(
  p_audit_id uuid,
  p_user_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Idempotency: only refund + fail if currently pending
  update public.audits
    set status = 'failed',
        failure_reason = p_reason,
        updated_at = now()
    where id = p_audit_id
      and status = 'pending';

  if not found then
    -- Already advanced or already failed — do not refund.
    return;
  end if;

  update public.profiles
    set audit_credits = audit_credits + 1,
        updated_at = now()
    where id = p_user_id;
end;
$$;

revoke all on function public.refund_orphan_audit(uuid,uuid,text) from public;
grant execute on function public.refund_orphan_audit(uuid,uuid,text) to service_role;
