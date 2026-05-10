-- C1+C2 hardening for `audit_credits`:
--
-- C1. Privilege escalation via `increment_audit_credits` RPC
--     0004 declared the RPC `SECURITY DEFINER` but never revoked the default
--     PUBLIC EXECUTE grant. PostgREST exposes any public-schema function with
--     EXECUTE to the `anon` and `authenticated` roles, which means any logged-in
--     user could `POST /rest/v1/rpc/increment_audit_credits` with arbitrary
--     args and award themselves credits. `refund_orphan_audit` in 0005 set the
--     correct precedent — copy the revoke/grant pattern here.
--
-- C2. Negative `audit_credits` (TOCTOU between `assertCanRunAudit` and the RPC)
--     The Phase-4 access gate reads `audit_credits` then calls the RPC. Two
--     concurrent `POST /api/audits` requests both observed credits=1 and both
--     ran the RPC, ending at -1 — and the gate returned `no_plan` permanently.
--     0005 added defensive CHECKs to every other column, but missed this one.
--     Fix: enforce the floor inside the UPDATE itself (an extra predicate that
--     fails the row match instead of saving the negative value), and add a
--     CHECK constraint as last-line-of-defense if a future caller forgets.
--
-- Wire compatibility:
--     `src/lib/access/decrement.ts` already maps `null` (and negatives) to a
--     thrown `'no_credits'`. Returning NULL from the RPC when the floor guard
--     rejects keeps the existing wrapper contract unchanged — no app-side
--     code change required.

-- ----------------------------------------------------------------------------
-- C2 (defense in depth): CHECK constraint floors `audit_credits` at zero.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_audit_credits_nonneg_check
    check (audit_credits >= 0);

-- ----------------------------------------------------------------------------
-- C2 (primary fix): atomic guard inside the UPDATE.
-- ----------------------------------------------------------------------------
-- The new function returns the new balance on success, NULL on rejection.
-- Rejection happens when the row would underflow (delta is negative AND the
-- post-update balance would go below zero). Positive deltas always succeed
-- (Stripe webhook crediting). The (delta >= 0 OR audit_credits + delta >= 0)
-- predicate is evaluated atomically inside the UPDATE as part of the WHERE
-- match — no separate read step exists for a concurrent transaction to race.

drop function if exists public.increment_audit_credits(uuid, int);

create or replace function public.increment_audit_credits(profile_id uuid, delta int)
returns int
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set audit_credits = audit_credits + delta,
         updated_at = now()
   where id = profile_id
     and (delta >= 0 or audit_credits + delta >= 0)
  returning audit_credits;
$$;

-- ----------------------------------------------------------------------------
-- C1: lock the RPC down to the service role only.
-- ----------------------------------------------------------------------------
revoke all on function public.increment_audit_credits(uuid, int) from public;
grant execute on function public.increment_audit_credits(uuid, int) to service_role;
