-- H3: atomic refund for audits that failed mid-pipeline (system fault).
--
-- The credit is decremented at audit-create time (POST /api/audits) before
-- the worker has had a chance to extract. If the worker subsequently fails
-- for non-user-fault reasons — Textract wedge, OCR/LLM 5xx after retry
-- budget, extraction-timeout, transient storage download error — the user
-- has spent a credit and received no report.
--
-- Until now the credit was lost: `mark-failed` in process-bill only wrote
-- failure_reason, and `cleanup-orphan-audits` / `refund_orphan_audit`
-- (0005) only handle rows that never left `status='pending'`. Once the
-- row advanced to `extracting`/`analyzing`, no refund path existed.
--
-- This RPC closes that gap with the same "claim then refund" pattern as
-- 0005:
--
--   1. Atomically flip `credit_consumed: true → false` ONLY if the row
--      currently has credit_consumed=true AND status='failed'. The status
--      filter ensures we only refund finalized rows (the caller should
--      flip to failed first).
--   2. If the claim succeeded (1 row), increment audit_credits by 1.
--   3. Otherwise no-op — another worker, or a previous retry of this
--      same worker, already refunded.
--
-- Idempotent under Inngest retry. The flip is the durable claim — once
-- credit_consumed=false, the WHERE clause rejects subsequent calls.

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
  -- Atomic claim: flip credit_consumed only if this row was both finalized
  -- as failed and is still flagged as having consumed a credit. If the
  -- caller's user_id doesn't match the row's owner, refuse (defense in
  -- depth against a misrouted event).
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

  return v_claimed;
end;
$$;

revoke all on function public.refund_failed_audit(uuid, uuid) from public;
grant execute on function public.refund_failed_audit(uuid, uuid) to service_role;

-- H4: atomic-once decrement for the audit-creation path.
--
-- The previous flow (audits/route.ts, inbound/email/route.ts) decremented
-- credits via `increment_audit_credits(delta=-1)` and then issued a SECOND
-- update to flip `audits.credit_consumed=true`. Two failure windows:
--
--   1. RPC succeeded server-side but the client never saw the response
--      (network blip). Wrapper threw; route caught and rolled back the
--      audit row WITHOUT refunding. Credit silently lost.
--   2. RPC succeeded AND wrapper returned, but the follow-up
--      `markCreditConsumed` UPDATE failed. Catch block deletes the audit
--      and refunds — but `credit_consumed` was never persisted, so a
--      concurrent reader could see the row as `credit_consumed=false`
--      and the orphan-cleanup cron would treat it as a subscription
--      audit (won't refund).
--
-- This RPC collapses both writes into one atomic statement. The flip on
-- `audits.credit_consumed` is the durable claim — once flipped, a retry
-- after a transient response failure finds credit_consumed=true and
-- no-ops. The caller treats both `granted=true` (first call) and
-- `granted=false` (idempotent retry) as success.
--
-- Returns:
--   * `granted=true`,  `new_balance=<int>` — this call performed the
--     decrement and flipped credit_consumed.
--   * `granted=false`, `new_balance=<int>` — credit was already consumed
--     for this audit (a previous retry won the race). new_balance is
--     the current balance, unchanged.
--   * `granted=null`, `new_balance=null`   — refused: either the audit
--     row doesn't exist / wrong user_id, or the user has no credits to
--     spend. Caller must treat as a failure path.

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
  -- Atomic claim: flip credit_consumed false → true. Gate on audit
  -- ownership + status to refuse misrouted/late calls.
  update public.audits
     set credit_consumed = true,
         updated_at = now()
   where id = p_audit_id
     and user_id = p_user_id
     and status = 'pending'
     and credit_consumed = false;

  if not found then
    -- Either already consumed (idempotent retry) or audit unknown / not
    -- pending. Distinguish via a SELECT so the caller knows whether to
    -- proceed or fail.
    select credit_consumed into v_already_consumed
      from public.audits
     where id = p_audit_id
       and user_id = p_user_id;

    if v_already_consumed is null then
      -- Unknown audit (or wrong owner). Refuse.
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

    -- credit_consumed=false but status changed. Refuse.
    return query select null::boolean as granted, null::int as new_balance;
    return;
  end if;

  -- Atomic decrement, floor-guarded the same way as
  -- increment_audit_credits.
  update public.profiles
     set audit_credits = audit_credits - 1,
         updated_at = now()
   where id = p_user_id
     and audit_credits >= 1
  returning audit_credits into v_balance;

  if not found then
    -- The user had no credits to spend. Roll back the credit_consumed
    -- flip so the audit row stays consistent.
    --
    -- The rollback must be scoped to the exact row WE flipped a moment
    -- ago (status='pending' + credit_consumed=true). Between the initial
    -- flip above and this rollback, a concurrent worker could have
    -- arrived for the same audit_id, observed credit_consumed=true
    -- (idempotent retry success), and proceeded with its own work — or a
    -- legitimate refund could have already reset the flag. Without the
    -- predicate guard, an unrelated row state would be clobbered to
    -- credit_consumed=false, which orphan-cleanup would then refund a
    -- second time. Scope the rollback so it only fires when the flag is
    -- still true (this run set it; nothing else has touched it).
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
