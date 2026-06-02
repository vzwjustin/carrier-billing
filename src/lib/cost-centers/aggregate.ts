/**
 * Cost-center allocation aggregator.
 *
 * Pure function — takes a flat list of bill-line cost-center + monthly-cost
 * rows and returns a sorted roll-up. Lines with no cost_center roll up under
 * the literal label `"(unassigned)"` so operators can see how much spend is
 * still untagged.
 *
 * Used by:
 *   - /src/app/(app)/dashboard/page.tsx for the "Spend by cost center" tile
 *   - /src/app/api/audits/[id]/cost-centers.csv for the CSV export
 *
 * Both surfaces consume the same shape; if you add a column here, update both.
 */
export const UNASSIGNED_LABEL = '(unassigned)';

export interface CostCenterLineInput {
  /** Operator-supplied cost-center label. NULL → "(unassigned)". */
  cost_center: string | null;
  /** Monthly base plan cost in cents. NULL → 0. */
  plan_base_cents: number | null;
}

export interface CostCenterRollupRow {
  cost_center: string;
  line_count: number;
  monthly_total_cents: number;
  /** 0..1 share of total monthly cents. 0 if total is 0. */
  share: number;
}

/**
 * Aggregate `lines` by `cost_center`. NULL groups under "(unassigned)".
 *
 * Sort order: highest monthly spend first, then alphabetical by label to keep
 * the output stable across calls. "(unassigned)" sorts purely by spend like
 * any other label — there's no special placement so operators can see at a
 * glance whether their untagged spend is large or small.
 */
export function aggregateCostCenters(
  lines: ReadonlyArray<CostCenterLineInput>,
): CostCenterRollupRow[] {
  const buckets = new Map<string, { line_count: number; monthly_total_cents: number }>();
  let total = 0;

  for (const line of lines) {
    const label =
      line.cost_center === null || line.cost_center.trim() === ''
        ? UNASSIGNED_LABEL
        : line.cost_center;
    const cents = line.plan_base_cents ?? 0;
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.line_count += 1;
      bucket.monthly_total_cents += cents;
    } else {
      buckets.set(label, { line_count: 1, monthly_total_cents: cents });
    }
    total += cents;
  }

  const rows: CostCenterRollupRow[] = Array.from(buckets.entries()).map(([cost_center, b]) => ({
    cost_center,
    line_count: b.line_count,
    monthly_total_cents: b.monthly_total_cents,
    share: total > 0 ? b.monthly_total_cents / total : 0,
  }));

  rows.sort((a, b) => {
    if (b.monthly_total_cents !== a.monthly_total_cents) {
      return b.monthly_total_cents - a.monthly_total_cents;
    }
    return a.cost_center.localeCompare(b.cost_center);
  });

  return rows;
}
