/**
 * Renewal Advisor — plan-benchmark helper.
 *
 * Pure function. Takes a flat list of bill_line rows (joined with the parent
 * audit's `carrier` value) and produces one benchmark row per matched legacy
 * plan, with the estimated monthly + annual savings of migrating every
 * matching line to the modern equivalent.
 *
 * Carrier scoping leans on `findMatchingLegacyPlan` from @/rules/helpers:
 *   - `null` or unknown carrier text is coerced to the 'unknown' sentinel
 *     which makes the matcher search the union of all carrier patterns.
 *   - Lines with `plan_name === null` are skipped (matcher returns null).
 *
 * Used by /src/app/(app)/renewal-advisor/page.tsx.
 */
import { CarrierSchema, type Carrier } from '@/extraction/schema';
import {
  findMatchingLegacyPlan,
  type LegacyPlanPattern,
} from '@/rules/helpers';

/**
 * Shape consumed from the `bill_lines` table. The page selects only the
 * columns we need; `carrier` is the parent audit's `carrier` value joined
 * in at the SQL layer.
 */
export interface BillLineRow {
  carrier: string | null;
  plan_name: string | null;
  plan_base_cents: number | null;
}

/**
 * One row of the benchmark table. There's at most one row per
 * (carrier, legacy_pattern) pair — multiple lines matching the same legacy
 * plan are aggregated.
 */
export interface BenchmarkRow {
  carrier: Carrier;
  legacy_plan_name: string;
  replacement_plan: string;
  source_note: string;
  line_count: number;
  /** Mean of plan_base_cents across matching lines, rounded to integer. */
  current_avg_monthly_cents: number;
  /** Per-line estimate from LEGACY_PLAN_PATTERNS. */
  estimated_per_line_savings_cents: number;
  /** line_count × estimated_per_line_savings_cents. */
  estimated_monthly_savings_cents: number;
  /** 12 × estimated_monthly_savings_cents. Surfaced because the UI displays
   *  annualized figures alongside the audit's `estimated_annual_savings`. */
  estimated_annual_savings_cents: number;
}

/**
 * Coerce raw text from the DB into a strict Carrier value. Unknown / null /
 * non-enum values fall through to 'unknown'.
 */
function coerceCarrier(value: string | null): Carrier {
  if (value === null) return 'unknown';
  const parsed = CarrierSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

/**
 * Group bill lines by the legacy plan they match (carrier-scoped) and return
 * one BenchmarkRow per group, sorted by estimated_monthly_savings_cents desc
 * (with legacy_plan_name as a stable tiebreaker).
 */
export function benchmarkPlans(
  lines: ReadonlyArray<BillLineRow>,
): BenchmarkRow[] {
  // Key by `${carrier}::${pattern.source}` so the same legacy plan name
  // surfaces separately for different carriers (e.g. legacy AT&T "Unlimited
  // Plus" vs Spectrum "Unlimited Plus").
  const buckets = new Map<
    string,
    {
      carrier: Carrier;
      pattern: LegacyPlanPattern;
      line_count: number;
      total_plan_base_cents: number;
      lines_with_plan_base: number;
    }
  >();

  for (const line of lines) {
    if (line.plan_name === null) continue;
    const carrier = coerceCarrier(line.carrier);
    const match = findMatchingLegacyPlan(line.plan_name, carrier);
    if (match === null) continue;

    const key = `${match.carrier}::${match.pattern.source}`;
    const existing = buckets.get(key);
    const planBase = line.plan_base_cents ?? null;
    if (existing) {
      existing.line_count += 1;
      if (planBase !== null) {
        existing.total_plan_base_cents += planBase;
        existing.lines_with_plan_base += 1;
      }
    } else {
      // Anchor the row to the pattern's declared carrier (e.g. 'verizon')
      // rather than the line's possibly-'unknown' carrier so the UI can
      // label the row reliably.
      const anchorCarrier: Carrier =
        match.carrier === 'all' ? carrier : match.carrier;
      buckets.set(key, {
        carrier: anchorCarrier,
        pattern: match,
        line_count: 1,
        total_plan_base_cents: planBase ?? 0,
        lines_with_plan_base: planBase !== null ? 1 : 0,
      });
    }
  }

  const rows: BenchmarkRow[] = Array.from(buckets.values()).map((b) => {
    const avg =
      b.lines_with_plan_base > 0
        ? Math.round(b.total_plan_base_cents / b.lines_with_plan_base)
        : 0;
    const monthly =
      b.line_count * b.pattern.estimated_monthly_savings_cents;
    return {
      carrier: b.carrier,
      legacy_plan_name: b.pattern.pattern.source,
      replacement_plan: b.pattern.replacement_plan,
      source_note: b.pattern.source_note,
      line_count: b.line_count,
      current_avg_monthly_cents: avg,
      estimated_per_line_savings_cents:
        b.pattern.estimated_monthly_savings_cents,
      estimated_monthly_savings_cents: monthly,
      estimated_annual_savings_cents: monthly * 12,
    };
  });

  rows.sort((a, b) => {
    if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
      return (
        b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents
      );
    }
    return a.legacy_plan_name.localeCompare(b.legacy_plan_name);
  });

  return rows;
}
