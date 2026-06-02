-- Audit follow-up (runner-2 F6): scope the `consume_audit_credit` rollback
-- UPDATE to the calling user as well as the audit row.
--
-- 0019 narrowed the rollback predicate to `where id = p_audit_id and
-- credit_consumed = true`. The initial claim (line ~29) is correctly scoped
-- with `and user_id = p_user_id`, but the rollback was not. Real-world risk is
-- negligible (audit_id is a UUID primary key, so it already identifies exactly
-- one row), but defense-in-depth: the rollback should never be able to touch a
-- row the caller does not own. Body is otherwise identical to 0019; only the
-- rollback WHERE clause gains `and user_id = p_user_id`.

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
    -- Scoped rollback: only clear credit_consumed if THIS run still owns the
    -- flag we set above (credit_consumed = true) AND the row belongs to the
    -- calling user. A concurrent caller racing this run for the same audit_id
    -- can have re-flipped it to true (idempotent retry success) — that flag is
    -- theirs, not ours, and must not be wiped.
    update public.audits
       set credit_consumed = false,
           updated_at = now()
     where id = p_audit_id
       and user_id = p_user_id
       and credit_consumed = true;
    return query select null::boolean as granted, null::int as new_balance;
    return;
  end if;

  return query select true as granted, v_balance as new_balance;
end;
$$;

revoke all on function public.consume_audit_credit(uuid, uuid) from public;
grant execute on function public.consume_audit_credit(uuid, uuid) to service_role;
