-- 0023 — Reviewer workflow on findings.
--
-- Adds a `status` lifecycle column to `findings` so operators can mark each
-- finding as new (default) → in_review → approved / rejected / disputed /
-- resolved. The downstream dispute-packet generator only acts on
-- `status = 'approved'` rows.
--
-- Pattern follows 0017: add columns first, install the CHECK constraint
-- alongside the column (no separate backfill step needed because the default
-- handles existing rows), and add a focused partial index for the UI's
-- "open items" filter so we don't seq-scan a growing findings table.
--
-- RLS is unchanged. The existing `"own audit children read"` SELECT policy
-- already covers reads. Writes go through the service-role admin client in
-- the API route (`/api/audits/[id]/findings/[findingId]/status`), matching
-- every other mutating route in the app — RLS-bypassing writes are gated
-- by an explicit ownership check in code before the UPDATE runs.
--
-- All changes are forward-only and safe to apply without downtime. New
-- columns are additive; existing rows pick up `status = 'new'` via the
-- default. `status_updated_at` / `status_updated_by` / `review_note` stay
-- NULL until the first transition.

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------

alter table public.findings
  add column if not exists status text not null default 'new',
  add column if not exists status_updated_at timestamptz,
  add column if not exists status_updated_by uuid references auth.users(id) on delete set null,
  add column if not exists review_note text;

-- ----------------------------------------------------------------------------
-- CHECK constraint — restrict to the documented status set.
--
-- Application code (Zod schema in the status route + literal union in
-- `FindingStatus`) is the primary gate; the DB constraint is the
-- belt-and-suspenders last line of defense, matching the pattern in
-- migration 0005.
-- ----------------------------------------------------------------------------

alter table public.findings
  add constraint findings_status_check
    check (status in ('new','in_review','approved','rejected','disputed','resolved'));

-- ----------------------------------------------------------------------------
-- Partial index — fast lookup of "open" items per audit.
--
-- The reviewer UI's primary query is "show me the findings that still need a
-- decision" (status in ('new','in_review')). A partial index keyed on
-- audit_id keeps that lookup cheap as the rejected/resolved tail accumulates.
-- ----------------------------------------------------------------------------

create index if not exists findings_status_open_idx
  on public.findings(audit_id)
  where status in ('new', 'in_review');
