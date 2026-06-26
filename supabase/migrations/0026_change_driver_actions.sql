-- 0026 — Bill Increase Autopsy: driver action columns
-- Lets the operator dispose of a change driver in the UI either by:
--   1. Marking it "explained" (reviewed, no action needed) — `is_explained`
--   2. Escalating it into a full audit finding — `escalated_finding_id`
--
-- Both columns are additive + nullable. Existing rows retain default state.
-- Migration 0024 was claimed by cost-center work, 0025 by contracts — this
-- is the next free number.

alter table public.bill_change_drivers
  add column if not exists is_explained boolean not null default false,
  add column if not exists explained_at timestamptz,
  add column if not exists explained_by uuid references auth.users(id) on delete set null,
  add column if not exists escalated_finding_id uuid references public.findings(id) on delete set null,
  add column if not exists escalated_at timestamptz;

-- Partial index: surfaces still-actionable drivers cheaply for the UI's
-- "show me what still needs review" view.
create index if not exists bill_change_drivers_unhandled_idx
  on public.bill_change_drivers(bill_comparison_id)
  where is_explained = false and escalated_finding_id is null;
