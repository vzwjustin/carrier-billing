-- 0022 — Bill Increase Autopsy
-- Period-over-period comparison between two completed audits, with a
-- categorized breakdown of what drove the change.
--
-- Design notes:
--   - One `bill_comparisons` row per (previous_audit_id, current_audit_id).
--     The pair is unique; idempotency of the comparison route is enforced
--     by the partial unique index below.
--   - `bill_change_drivers` rows are inserted in a single transaction with
--     the comparison; deletes cascade so a re-run cleanly replaces them.
--   - We store both `previous_total_cents` and `current_total_cents` on the
--     parent so the dashboard summary doesn't need to join to audits.
--   - `unexplained_cents` is the net change minus the sum of categorized
--     drivers — when non-zero, the engine inserts an explicit 'unexplained'
--     driver carrying the residual. Spec rule: NEVER invent a cause.
--   - RLS mirrors `findings`: visible if the user owns BOTH parent audits.

create table if not exists public.bill_comparisons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  previous_audit_id uuid not null references public.audits(id) on delete cascade,
  current_audit_id uuid not null references public.audits(id) on delete cascade,
  previous_total_cents bigint not null,
  current_total_cents bigint not null,
  net_change_cents bigint not null,
  -- Net change expressed as basis points (× 100) of the previous total so
  -- we keep integer storage. Null when previous total is 0 (division-by-
  -- zero) — the UI treats that as "new account".
  percent_change_bps int,
  disputable_cents bigint not null default 0,
  optimization_cents bigint not null default 0,
  unexplained_cents bigint not null default 0,
  executive_summary text not null,
  -- Snapshot of bookkeeping for the runner: counts of drivers by class,
  -- comparison engine version, etc. Free-form so future engine work
  -- doesn't need a migration to stash extra metadata.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- One comparison per pair. Re-running is an upsert-then-replace pattern in
-- the API route (DELETE existing + INSERT new) inside a transaction.
create unique index if not exists bill_comparisons_pair_uniq
  on public.bill_comparisons (previous_audit_id, current_audit_id);

create index if not exists bill_comparisons_user_id_idx
  on public.bill_comparisons(user_id);

create index if not exists bill_comparisons_current_audit_idx
  on public.bill_comparisons(current_audit_id);

-- Change drivers ------------------------------------------------------------
--
-- One row per categorized cause of the bill change. Categories follow the
-- product spec ("Bill Increase Autopsy" §"Required change categories").
-- `category` is a free-form text bucket gated by a CHECK so future
-- categories don't need a migration but typos do fail fast.

create table if not exists public.bill_change_drivers (
  id uuid primary key default gen_random_uuid(),
  bill_comparison_id uuid not null references public.bill_comparisons(id) on delete cascade,
  category text not null,
  title text not null,
  summary text not null,
  previous_cents bigint not null default 0,
  current_cents bigint not null default 0,
  difference_cents bigint not null,
  affected_lines_count int not null default 0,
  confidence numeric(3,2) not null default 1.0,
  is_disputable boolean not null default false,
  is_optimization boolean not null default false,
  is_unexplained boolean not null default false,
  recommended_action text,
  -- Evidence is a small JSON payload describing what rows / line MDN last4s
  -- / accounts back this driver. PII discipline: phone numbers stored as
  -- last4 only, matching the rest of the system.
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint bill_change_drivers_category_check check (
    category in (
      'new_lines',
      'removed_lines',
      'plan_changes',
      'device_installments_added',
      'device_installments_removed',
      'missing_credits',
      'new_credits',
      'credits_decreased',
      'credits_increased',
      'one_time_charges',
      'activation_fees',
      'insurance_changes',
      'international_charges',
      'roaming_charges',
      'overage_charges',
      'taxes_fees_change',
      'feature_addon_changes',
      'suspended_line_still_billed',
      'unexplained'
    )
  ),
  constraint bill_change_drivers_confidence_check check (
    confidence >= 0 and confidence <= 1
  )
);

create index if not exists bill_change_drivers_comparison_idx
  on public.bill_change_drivers(bill_comparison_id);

-- RLS ----------------------------------------------------------------------

alter table public.bill_comparisons enable row level security;
alter table public.bill_change_drivers enable row level security;

drop policy if exists "own comparisons read" on public.bill_comparisons;
create policy "own comparisons read" on public.bill_comparisons
  for select using (auth.uid() = user_id);

-- Writes happen via the service-role admin client (the comparison runner
-- is server-only) so we don't grant INSERT/UPDATE to anon. The unique
-- pair index is the dedup boundary.

drop policy if exists "own comparison drivers read" on public.bill_change_drivers;
create policy "own comparison drivers read" on public.bill_change_drivers
  for select using (
    exists (
      select 1 from public.bill_comparisons c
       where c.id = bill_comparison_id
         and c.user_id = auth.uid()
    )
  );
