-- 0016 — idempotent Stripe one-time audit-credit grants.
--
-- `checkout.session.completed` for one-time purchases grants exactly one
-- audit credit. The previous retry guard skipped the grant on replay, which
-- avoided double-crediting but could lose the credit if the first handler
-- attempt crashed before the increment. This ledger + RPC makes the grant
-- itself idempotent: insert the Stripe event id and increment the profile in
-- one transaction; duplicate event ids no-op.

create table if not exists public.audit_credit_grants (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.audit_credit_grants enable row level security;
revoke all on public.audit_credit_grants from public;
revoke all on public.audit_credit_grants from anon, authenticated;

create index if not exists audit_credit_grants_profile_id_idx
  on public.audit_credit_grants(profile_id);

create or replace function public.grant_audit_credit_once(
  p_profile_id uuid,
  p_stripe_event_id text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
  new_balance integer;
begin
  insert into public.audit_credit_grants (profile_id, stripe_event_id)
  values (p_profile_id, p_stripe_event_id)
  on conflict (stripe_event_id) do nothing;

  get diagnostics inserted_count = row_count;

  if inserted_count = 0 then
    select audit_credits into new_balance
      from public.profiles
      where id = p_profile_id;
    return new_balance;
  end if;

  update public.profiles
    set audit_credits = audit_credits + 1,
        updated_at = now()
    where id = p_profile_id
    returning audit_credits into new_balance;

  if new_balance is null then
    raise exception 'profile % not found', p_profile_id
      using errcode = 'P0002';
  end if;

  return new_balance;
end;
$$;

revoke all on function public.grant_audit_credit_once(uuid,text) from public;
grant execute on function public.grant_audit_credit_once(uuid,text) to service_role;
