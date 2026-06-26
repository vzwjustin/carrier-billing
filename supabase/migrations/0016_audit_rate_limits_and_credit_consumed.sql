-- Audit remediation hardening.
--
-- 1. Track whether an audit actually consumed a one-time credit so orphan
--    cleanup cannot mint credits for subscription-created audits.
-- 2. Add a tiny database-backed rate limiter for high-cost authenticated
--    actions. SECURITY DEFINER keeps callers service-role only.

alter table public.audits
  add column if not exists credit_consumed boolean not null default false;

create table if not exists public.rate_limit_buckets (
  key text primary key,
  count int not null default 0,
  window_start timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public;
revoke all on public.rate_limit_buckets from anon, authenticated;

drop trigger if exists rate_limit_buckets_set_updated_at on public.rate_limit_buckets;
create trigger rate_limit_buckets_set_updated_at
  before update on public.rate_limit_buckets
  for each row execute function public.set_updated_at();

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns table(allowed boolean, remaining int, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count int;
begin
  if p_key is null or length(p_key) = 0 or p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'invalid_rate_limit_args';
  end if;

  insert into public.rate_limit_buckets as b (key, count, window_start)
    values (p_key, 1, v_now)
  on conflict (key) do update
    set count = case
          when b.window_start <= v_now - make_interval(secs => p_window_seconds) then 1
          else b.count + 1
        end,
        window_start = case
          when b.window_start <= v_now - make_interval(secs => p_window_seconds) then v_now
          else b.window_start
        end
  returning b.window_start, b.count
    into v_window_start, v_count;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);
  reset_at := v_window_start + make_interval(secs => p_window_seconds);
  return next;
end;
$$;

revoke all on function public.consume_rate_limit(text,int,int) from public;
grant execute on function public.consume_rate_limit(text,int,int) to service_role;

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
