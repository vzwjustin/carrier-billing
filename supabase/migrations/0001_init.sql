-- CarrierAudit initial schema
-- Source of truth: CLAUDE.md §4

-- Extensions ----------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Updated-at trigger function ----------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles ------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  company_name text,
  stripe_customer_id text unique,
  subscription_status text,        -- 'active' | 'canceled' | 'past_due' | null
  subscription_id text,
  audit_credits int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Audits --------------------------------------------------------------------

create table if not exists public.audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
    -- 'pending' | 'extracting' | 'analyzing' | 'completed' | 'failed'
  carrier text,                    -- 'verizon' | 'att' | 'tmobile' | 'unknown'
  storage_path text not null,
  original_filename text not null,
  file_size_bytes bigint,
  page_count int,
  billing_period_start date,
  billing_period_end date,
  total_charges_cents bigint,
  account_count int,
  line_count int,
  estimated_monthly_savings_cents bigint default 0,
  estimated_annual_savings_cents bigint default 0,
  finding_count int default 0,
  high_severity_count int default 0,
  share_token text unique,
  failure_reason text,
  inngest_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists audits_user_id_idx on public.audits(user_id);
create index if not exists audits_status_idx on public.audits(status);

drop trigger if exists audits_set_updated_at on public.audits;
create trigger audits_set_updated_at
  before update on public.audits
  for each row execute function public.set_updated_at();

-- Bill accounts -------------------------------------------------------------

create table if not exists public.bill_accounts (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  account_number_masked text,
  account_label text,
  total_charges_cents bigint,
  taxes_fees_cents bigint,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bill lines ----------------------------------------------------------------

create table if not exists public.bill_lines (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  account_id uuid not null references public.bill_accounts(id) on delete cascade,
  mdn_masked text,
  user_label text,
  device_description text,
  plan_name text,
  plan_base_cents bigint,
  data_used_gb numeric(8,2),
  voice_used_min int,
  sms_used_count int,
  is_suspended boolean default false,
  is_active_dpp boolean default false,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bill_lines_audit_id_idx on public.bill_lines(audit_id);

-- Bill features -------------------------------------------------------------

create table if not exists public.bill_features (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.bill_lines(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  name text not null,
  category text,
  monthly_charge_cents bigint not null,
  created_at timestamptz not null default now()
);

-- Bill credits --------------------------------------------------------------

create table if not exists public.bill_credits (
  id uuid primary key default gen_random_uuid(),
  line_id uuid references public.bill_lines(id) on delete cascade,
  account_id uuid references public.bill_accounts(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  name text not null,
  monthly_amount_cents bigint not null,
  expires_on date,
  is_promo boolean default true,
  created_at timestamptz not null default now()
);

-- Bill DPP installments -----------------------------------------------------

create table if not exists public.bill_dpp_installments (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.bill_lines(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  device_description text,
  monthly_payment_cents bigint not null,
  remaining_payments int,
  total_payments int,
  created_at timestamptz not null default now()
);

-- Findings ------------------------------------------------------------------

create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  rule_id text not null,
  severity text not null,
  title text not null,
  description text not null,
  recommended_action text not null,
  estimated_monthly_savings_cents bigint not null default 0,
  confidence numeric(3,2) not null default 1.0,
  affected_line_ids uuid[],
  affected_account_ids uuid[],
  evidence jsonb,
  created_at timestamptz not null default now()
);

create index if not exists findings_audit_id_idx on public.findings(audit_id);
create index if not exists findings_severity_idx on public.findings(severity);

-- Billing events ------------------------------------------------------------

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  stripe_event_id text unique not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Row Level Security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.audits enable row level security;
alter table public.bill_accounts enable row level security;
alter table public.bill_lines enable row level security;
alter table public.bill_features enable row level security;
alter table public.bill_credits enable row level security;
alter table public.bill_dpp_installments enable row level security;
alter table public.findings enable row level security;
alter table public.billing_events enable row level security;

-- Profiles: a user can read/update only their own profile
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id);

-- Audits: user owns their audits
drop policy if exists "own audits all" on public.audits;
create policy "own audits all" on public.audits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- bill_accounts: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.bill_accounts;
create policy "own audit children read" on public.bill_accounts
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- bill_lines: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.bill_lines;
create policy "own audit children read" on public.bill_lines
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- bill_features: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.bill_features;
create policy "own audit children read" on public.bill_features
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- bill_credits: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.bill_credits;
create policy "own audit children read" on public.bill_credits
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- bill_dpp_installments: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.bill_dpp_installments;
create policy "own audit children read" on public.bill_dpp_installments
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- findings: visible if user owns the parent audit
drop policy if exists "own audit children read" on public.findings;
create policy "own audit children read" on public.findings
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );

-- billing_events: visible only to the owning user (writes are service-role only)
drop policy if exists "own billing events read" on public.billing_events;
create policy "own billing events read" on public.billing_events
  for select using (auth.uid() = user_id);

-- New-user trigger ----------------------------------------------------------
-- Creates a public.profiles row whenever a new auth.users row is inserted.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
