-- 0039 — Bulk Refund RPC for leaked credits optimization
--
-- This creates a bulk version of refund_failed_audit to avoid N+1 queries
-- when the cleanup orphan audits cron sweeps multiple failed records.
--
-- Like refund_failed_audit:
--   1. Flip audits.credit_consumed = false for eligible rows.
--   2. Increment profiles.audit_credits by the number of audits reclaimed per user.
--   3. We ensure atomicity by wrapping in standard plpgsql block.

create or replace function public.refund_failed_audits_bulk(
  p_audit_ids uuid[],
  p_user_ids uuid[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refunded int := 0;
  v_user_refunds record;
begin
  -- Validate arrays match length
  if array_length(p_audit_ids, 1) != array_length(p_user_ids, 1) then
    raise exception 'refund_failed_audits_bulk: arrays must be same length';
  end if;

  -- Create a temporary mapping of the input pairs
  create temp table tmp_bulk_refunds on commit drop as
  select a as audit_id, u as user_id
  from unnest(p_audit_ids, p_user_ids) as t(a, u);

  -- 1. Atomic claim: flip credit_consumed only for rows that are still failed/consumed
  -- and match the given audit_id/user_id pairs.
  -- We collect which audits were ACTUALLY flipped, so we know exactly how many
  -- credits to grant per user.
  create temp table tmp_claimed on commit drop as
  with claimed as (
    update public.audits a
       set credit_consumed = false,
           updated_at = now()
      from tmp_bulk_refunds t
     where a.id = t.audit_id
       and a.user_id = t.user_id
       and a.status = 'failed'
       and a.credit_consumed = true
    returning a.id, a.user_id
  )
  select * from claimed;

  select count(*) into v_refunded from tmp_claimed;

  if v_refunded = 0 then
    return 0;
  end if;

  -- 2. Increment credits per user for the claims we just won.
  for v_user_refunds in (
    select user_id, count(*) as credits_to_grant
    from tmp_claimed
    group by user_id
  ) loop
    update public.profiles
       set audit_credits = audit_credits + v_user_refunds.credits_to_grant,
           updated_at = now()
     where id = v_user_refunds.user_id;

    if not found then
      raise exception 'refund_failed_audits_bulk: profile % not found; refund rolled back', v_user_refunds.user_id;
    end if;
  end loop;

  return v_refunded;
end;
$$;

revoke all on function public.refund_failed_audits_bulk(uuid[], uuid[]) from public;
grant execute on function public.refund_failed_audits_bulk(uuid[], uuid[]) to service_role;
