-- C2 follow-up: re-publish `consume_audit_credit` with a scoped rollback
-- predicate.
--
-- 0018 introduced this RPC with a rollback UPDATE that did
-- `where id = p_audit_id` only. Between the initial credit_consumed=true
-- flip and this rollback, a concurrent retry can land for the same
-- audit_id; the unscoped rollback would clobber that retry's just-set
-- flag, and orphan-cleanup would then double-refund the credit a second
-- caller legitimately spent.
--
-- Fresh environments take this fix directly via the updated 0018. This
-- migration exists so environments that already applied buggy 0018 get
-- the corrected function definition (CREATE OR REPLACE FUNCTION). The
-- body is otherwise identical to 0018's; only the rollback WHERE clause
-- gains the `and credit_consumed = true` predicate.

create or replace function public.consume_audit_credit(
  p_audit_id uuid,
  p_user_id uuid
) returns table(granted boolean, new_balance int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_consumed boolean;
  v_balance int;
begin
  update public.audits
     set credit_consumed = true,
         updated_at = now()
   where id = p_audit_id
     and user_id = p_user_id
     and status = 'pending'
     and credit_consumed = false;

  if not found then
    select credit_consumed into v_already_consumed
      from public.audits
     where id = p_audit_id
       and user_id = p_user_id;

    if v_already_consumed is null then
      return query select null::boolean as granted, null::int as new_balance;
      return;
    end if;

    if v_already_consumed = true then
      select audit_credits into v_balance
        from public.profiles
       where id = p_user_id;
      return query select false as granted, v_balance as new_balance;
      return;
    end if;

    return query select null::boolean as granted, null::int as new_balance;
    return;
  end if;

  update public.profiles
     set audit_credits = audit_credits - 1,
         updated_at = now()
   where id = p_user_id
     and audit_credits >= 1
  returning audit_credits into v_balance;

  if not found then
    -- Scoped rollback: only clear credit_consumed if THIS run still owns
    -- the flag we set above. A concurrent caller racing this run for the
    -- same audit_id can have re-flipped it to true (idempotent retry
    -- success) — that flag is theirs, not ours, and must not be wiped.
    update public.audits
       set credit_consumed = false,
           updated_at = now()
     where id = p_audit_id
       and credit_consumed = true;
    return query select null::boolean as granted, null::int as new_balance;
    return;
  end if;

  return query select true as granted, v_balance as new_balance;
end;
$$;

revoke all on function public.consume_audit_credit(uuid, uuid) from public;
grant execute on function public.consume_audit_credit(uuid, uuid) to service_role;
