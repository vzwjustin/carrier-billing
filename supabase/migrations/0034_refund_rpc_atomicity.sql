-- 0034 — Refund RPC atomicity (bug hunt #1)
--
-- Both refund RPCs perform the durable claim first (flip audits.credit_consumed
-- false, gated on status/owner, with `if not found then return`), THEN run
--   update public.profiles set audit_credits = audit_credits + 1 where id = p_user_id
-- with NO `if not found` check, and return success unconditionally.
--
-- If the profiles row is absent or mismatched (deleted account, misrouted
-- user_id), the claim has already cleared credit_consumed=false but the +1
-- matched zero rows and silently no-ops. Because credit_consumed is now false,
-- the claim's WHERE predicate can never re-match on retry, so the refund is
-- permanently, invisibly lost while the RPC reports success.
--
-- Fix: raise after a zero-row profiles increment so the ENTIRE PL/pgSQL block
-- (claim flip + increment) rolls back atomically and a later retry can re-claim
-- — mirroring grant_credit_once's explicit `if not found then raise exception`.
--
-- Forward-only: `create or replace` swaps the function body in place. Also
-- re-asserts `revoke all ... from public` so EXECUTE is service-role-only
-- (defense against the anon-executable SECURITY DEFINER exposure).

create or replace function public.refund_failed_audit(
  p_audit_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  update public.audits
     set credit_consumed = false,
         updated_at = now()
   where id = p_audit_id
     and user_id = p_user_id
     and status = 'failed'
     and credit_consumed = true;

  if not found then
    return false;
  end if;
  v_claimed := true;

  update public.profiles
     set audit_credits = audit_credits + 1,
         updated_at = now()
   where id = p_user_id;

  -- #1: if the profile didn't match, the claim flip above already cleared
  -- credit_consumed; raise so the whole block rolls back and the row stays
  -- reclaimable instead of silently losing the credit.
  if not found then
    raise exception 'refund_failed_audit: profile % not found; refund rolled back', p_user_id;
  end if;

  return v_claimed;
end;
$$;

revoke all on function public.refund_failed_audit(uuid, uuid) from public;
grant execute on function public.refund_failed_audit(uuid, uuid) to service_role;

create or replace function public.refund_orphan_audit(
  p_audit_id uuid,
  p_user_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit_consumed boolean;
begin
  update public.audits
    set status = 'failed',
        failure_reason = p_reason,
        credit_consumed = false,
        updated_at = now()
    where id = p_audit_id
      and user_id = p_user_id
      and status = 'pending'
      and credit_consumed = true
  returning true into v_credit_consumed;

  if found then
    update public.profiles
      set audit_credits = audit_credits + 1,
          updated_at = now()
      where id = p_user_id;
    -- #1: same rationale as refund_failed_audit — roll back the claim flip
    -- if the profile increment matched no row.
    if not found then
      raise exception 'refund_orphan_audit: profile % not found; refund rolled back', p_user_id;
    end if;
    return;
  end if;

  update public.audits
    set status = 'failed',
        failure_reason = p_reason,
        updated_at = now()
    where id = p_audit_id
      and user_id = p_user_id
      and status = 'pending'
      and credit_consumed = false;
end;
$$;

revoke all on function public.refund_orphan_audit(uuid,uuid,text) from public;
grant execute on function public.refund_orphan_audit(uuid,uuid,text) to service_role;
