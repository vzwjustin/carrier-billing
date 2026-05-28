-- Carrier connections -------------------------------------------------------
-- One row per (user, carrier). Tracks a user's link to a carrier account.
--
-- NOTE: Verizon / AT&T / T-Mobile expose no public consumer billing API.
-- "Authentication" and "bill retrieval" are necessarily a simulated adapter
-- (see src/lib/carriers/). This table stores only non-PII metadata: a
-- friendly label (e.g. account last-4) and sync status — never credentials.

create table if not exists public.carrier_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  carrier text not null
    check (carrier in ('verizon', 'att', 'tmobile')),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'error')),
  account_label text
    check (account_label is null or char_length(account_label) <= 64),
  last_error text
    check (last_error is null or char_length(last_error) <= 280),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, carrier)
);

create index if not exists carrier_connections_user_id_idx
  on public.carrier_connections(user_id);

alter table public.carrier_connections enable row level security;

-- Owner can do everything with their own connections; nobody else can see
-- them. Service-role (Inngest sync jobs) bypasses RLS as elsewhere.
drop policy if exists "own carrier connections all"
  on public.carrier_connections;
create policy "own carrier connections all"
  on public.carrier_connections
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists carrier_connections_set_updated_at
  on public.carrier_connections;
create trigger carrier_connections_set_updated_at
  before update on public.carrier_connections
  for each row execute function public.set_updated_at();
