-- Editable carrier bills ----------------------------------------------------
-- A user-editable working copy of a carrier bill (manual entry or pulled via
-- the simulated adapter). Line items are stored as JSONB so the editor can
-- add/remove/modify rows freely; money is integer cents to match the rest of
-- the schema. This is intentionally separate from the read-only extracted
-- bill_* tables (which are an audit's immutable record).

create table if not exists public.carrier_bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  carrier text not null
    check (carrier in ('verizon', 'att', 'tmobile')),
  label text not null default 'Untitled bill'
    check (char_length(label) <= 120),
  -- [{ id, description, monthlyCents, optimizedCents }]
  line_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists carrier_bills_user_id_idx
  on public.carrier_bills(user_id);
create index if not exists carrier_bills_user_carrier_idx
  on public.carrier_bills(user_id, carrier);

alter table public.carrier_bills enable row level security;

drop policy if exists "own carrier bills all" on public.carrier_bills;
create policy "own carrier bills all"
  on public.carrier_bills
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists carrier_bills_set_updated_at on public.carrier_bills;
create trigger carrier_bills_set_updated_at
  before update on public.carrier_bills
  for each row execute function public.set_updated_at();
