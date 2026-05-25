-- 0025 — Contract intelligence library
--
-- Lets users upload carrier contracts / quotes / promo sheets, extracts
-- structured terms with Claude, and surfaces them to the rules engine so a
-- new audit rule can flag lines billed above the contracted rate.
--
-- Design notes:
--   - `contracts` is the parent envelope (file, owner, status, extracted
--     metadata used for matching against bills: carrier + BAN-last4, plus
--     effective/expiration dates).
--   - `contract_terms` holds the actual extracted contract terms. All
--     fields are nullable so a partial extraction can still persist what
--     the LLM was confident about; the UI lets the user fill the rest by
--     hand via PATCH.
--   - Status CHECK constraint matches the audits table convention
--     (pending → extracting → parsed | failed). `failure_reason` is bounded
--     by the API layer the same way `audits.failure_reason` is.
--   - Money is integer cents to match the rest of the system; percentages
--     are basis points (× 100) so they remain integer storage.
--   - Storage bucket: skip migration; operators create the `contracts`
--     private bucket manually the same way they create `bills` / `reports`
--     (the SQL bucket-create requires service-role and is more reliable
--     done via the dashboard). README addendum documents this.
--   - RLS mirrors the established pattern: owner-only on contracts;
--     contract_terms visible if the user owns the parent contract.

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  original_filename text not null,
  storage_path text not null,
  carrier text,                    -- 'verizon' | 'att' | 'tmobile' | 'unknown'
  ban_last4 text,                  -- last 4 of Billing Account Number, like bill_accounts.account_number_masked
  effective_date date,
  expiration_date date,
  status text not null default 'pending',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_status_check check (
    status in ('pending', 'extracting', 'parsed', 'failed')
  )
);

drop trigger if exists contracts_set_updated_at on public.contracts;
create trigger contracts_set_updated_at
  before update on public.contracts
  for each row execute function public.set_updated_at();

create index if not exists contracts_user_id_idx on public.contracts(user_id);
-- Partial index: only contracts with a carrier set are useful for joining
-- against bills. The `where carrier is not null` clause keeps the index
-- small for pending/failed contracts that never got an extracted carrier.
create index if not exists contracts_carrier_ban_idx
  on public.contracts(carrier, ban_last4)
  where carrier is not null;

-- Extracted terms --------------------------------------------------------

create table if not exists public.contract_terms (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  plan_name text,
  contracted_monthly_rate_cents bigint,
  -- Discount expressed in basis points (× 100) so we keep integer storage.
  -- e.g. 12.5% off = 1250. Constrained 0..10000 (0%..100%).
  discount_percentage_bps int,
  -- Waived fees: a JSONB array of {name, monthly_cents?} entries describing
  -- fees the contract waives ("activation fee", "upgrade fee", "line
  -- access fee"). Stored as jsonb so the UI can render whatever shape the
  -- extractor produced without a migration per new fee type.
  waived_fees jsonb,
  promo_credit_cents bigint,
  promo_duration_months int,
  device_credit_terms text,
  line_minimums int,
  upgrade_fee_rules text,
  activation_fee_rules text,
  international_package_terms text,
  early_termination_terms text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_terms_discount_bps_check check (
    discount_percentage_bps is null
    or (discount_percentage_bps >= 0 and discount_percentage_bps <= 10000)
  )
);

drop trigger if exists contract_terms_set_updated_at on public.contract_terms;
create trigger contract_terms_set_updated_at
  before update on public.contract_terms
  for each row execute function public.set_updated_at();

create index if not exists contract_terms_contract_id_idx
  on public.contract_terms(contract_id);

-- Row Level Security -----------------------------------------------------

alter table public.contracts enable row level security;
alter table public.contract_terms enable row level security;

-- contracts: owner-only access for select/insert/update/delete. Writes from
-- service-role (Inngest worker) bypass RLS the same way audit writes do.
drop policy if exists "own contracts all" on public.contracts;
create policy "own contracts all" on public.contracts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- contract_terms: visible to the user if they own the parent contract.
-- Writes happen via service-role (Inngest worker) or via the PATCH route
-- which performs an explicit ownership check before calling the admin
-- client; we still want the SELECT policy here for the detail page that
-- reads via the RLS-scoped server client.
drop policy if exists "own contract terms read" on public.contract_terms;
create policy "own contract terms read" on public.contract_terms
  for select using (
    exists (
      select 1 from public.contracts c
       where c.id = contract_id
         and c.user_id = auth.uid()
    )
  );

drop policy if exists "own contract terms update" on public.contract_terms;
create policy "own contract terms update" on public.contract_terms
  for update using (
    exists (
      select 1 from public.contracts c
       where c.id = contract_id
         and c.user_id = auth.uid()
    )
  );
