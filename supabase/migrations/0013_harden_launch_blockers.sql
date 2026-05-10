-- Launch hardening: trusted-write boundaries, inbound email dedupe, and storage
-- immutability.
--
-- Credit-balance and increment_audit_credits hardening landed in
-- 0007_credits_hardening.sql; Stripe webhook replay state landed in
-- 0008_stripe_webhook_hardening.sql. This migration adds the remaining
-- launch-blocker hardening: RLS write lockdown for browser roles, an
-- inbound-email dedupe table, and removal of update/delete policies on the
-- bills storage bucket.

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
