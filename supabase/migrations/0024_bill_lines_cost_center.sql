-- 0024 — Cost-center allocation tags on bill_lines.
--
-- Operators tag individual lines with a free-form cost-center label after
-- extraction so they can roll up spend per business unit / project / GL code.
-- Tagging is purely operator-supplied — extraction never populates this — so
-- both columns are nullable with no default. Existing rows stay NULL; no
-- backfill required.
--
-- Reads: covered by the existing "own_audit_children_read" policy on
-- bill_lines (joins through audits.user_id). Writes happen via the API route
-- POST /api/audits/[id]/lines/[lineId]/cost-center which validates ownership
-- then uses the service-role client.
--
-- Forward-only and safe to apply without downtime.

alter table public.bill_lines
  add column if not exists cost_center text,
  add column if not exists cost_center_updated_at timestamptz;

-- Partial index: unassigned lines dominate the table, so excluding them
-- keeps the index narrow and the cost-center roll-up query fast.
create index if not exists bill_lines_cost_center_idx
  on public.bill_lines(audit_id, cost_center)
  where cost_center is not null;
