-- Launch hardening: trusted-write boundaries, credit invariants, webhook replay
-- state, inbound email dedupe, and storage immutability.

-- ----------------------------------------------------------------------------
-- Profiles: browser clients may read their own profile but must not directly
-- mutate billing, credit, token, or webhook-secret columns. Server actions,
-- webhooks, and workers use the service-role client and bypass RLS.
-- ----------------------------------------------------------------------------

drop policy if exists "own profile update" on public.profiles;

revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- Audits: users may read their own audits; trusted server routes/workers own all
-- audit writes. This prevents browser clients from forging status/report totals.
-- ----------------------------------------------------------------------------

drop policy if exists "own audits all" on public.audits;
drop policy if exists "own audits read" on public.audits;
create policy "own audits read" on public.audits
  for select using (auth.uid() = user_id);

revoke insert, update, delete on public.audits from anon, authenticated;
grant select on public.audits to authenticated;

-- ----------------------------------------------------------------------------
-- Credit accounting: prevent negative balances in the ledger itself, and ensure
-- the SECURITY DEFINER credit RPC cannot be invoked by browser roles.
-- ----------------------------------------------------------------------------

update public.profiles
   set audit_credits = 0,
       updated_at = now()
 where audit_credits < 0;

alter table public.profiles
  drop constraint if exists profiles_audit_credits_nonnegative;
alter table public.profiles
  add constraint profiles_audit_credits_nonnegative
    check (audit_credits >= 0);

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

revoke all on function public.increment_audit_credits(uuid,int) from public;
revoke all on function public.increment_audit_credits(uuid,int) from anon;
revoke all on function public.increment_audit_credits(uuid,int) from authenticated;
grant execute on function public.increment_audit_credits(uuid,int) to service_role;

-- ----------------------------------------------------------------------------
-- Stripe webhook replay state. A row is deduped only after handled_at is set;
-- handler failures are retried by Stripe and remain visible for manual triage.
-- ----------------------------------------------------------------------------

alter table public.billing_events
  add column if not exists handled_at timestamptz,
  add column if not exists processing_started_at timestamptz,
  add column if not exists handler_error text;

-- Preserve existing idempotency semantics for historical event receipts. New
-- rows start with handled_at null until the route finishes the handler.
update public.billing_events
   set handled_at = created_at
 where handled_at is null;

create index if not exists billing_events_unhandled_idx
  on public.billing_events(created_at)
  where handled_at is null;

create or replace function public.claim_billing_event_for_handling(
  p_stripe_event_id text,
  p_stale_before timestamptz
) returns boolean
language sql
security definer
set search_path = public
as $$
  update public.billing_events
     set processing_started_at = now()
   where stripe_event_id = p_stripe_event_id
     and handled_at is null
     and (
       processing_started_at is null
       or processing_started_at < p_stale_before
     )
  returning true;
$$;

revoke all on function public.claim_billing_event_for_handling(text,timestamptz)
  from public;
revoke all on function public.claim_billing_event_for_handling(text,timestamptz)
  from anon;
revoke all on function public.claim_billing_event_for_handling(text,timestamptz)
  from authenticated;
grant execute on function public.claim_billing_event_for_handling(text,timestamptz)
  to service_role;

-- ----------------------------------------------------------------------------
-- Inbound email dedupe. Store only a payload hash, never raw email contents.
-- ----------------------------------------------------------------------------

create table if not exists public.inbound_email_events (
  id uuid primary key default gen_random_uuid(),
  event_hash text not null unique,
  user_id uuid references public.profiles(id) on delete set null,
  audit_id uuid references public.audits(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.inbound_email_events enable row level security;
revoke all on public.inbound_email_events from public;
revoke all on public.inbound_email_events from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Bills storage: users only need insert/read on their own prefix. Updates and
-- deletes would allow source-file tampering while a worker is processing.
-- ----------------------------------------------------------------------------

drop policy if exists "users update own bills" on storage.objects;
drop policy if exists "users delete own bills" on storage.objects;
