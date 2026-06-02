/**
 * Executive (multi-audit) report — pure data builder.
 *
 * Given the last N completed audits (newest first), their findings, any
 * `bill_comparisons` between them, and `bill_lines` (for cost-center
 * roll-ups), produces a deterministic `ExecutiveReportData` shape that the
 * renderer consumes.
 *
 * Pure: no I/O, no `new Date()`, no env reads. Safe to snapshot.
 *
 * PII discipline (CLAUDE.md §1#5): we never embed full phone numbers,
 * user_label, or raw user email. Aggregates and counts only.
 */
import {
  aggregateCostCenters,
  type CostCenterLineInput,
  type CostCenterRollupRow,
} from '@/lib/cost-centers/aggregate';
import type { ReportAuditRow, ReportFindingRow } from '@/reports/types';
import type { FindingStatus, Severity } from '@/rules/types';

/**
 * Reviewer statuses we consider as "still actionable" for top findings. We
 * intentionally exclude rejected/disputed/resolved because those have been
 * worked already; surfacing them to the CFO would be noise.
 */
const ACTIONABLE_STATUSES: readonly FindingStatus[] = ['new', 'in_review', 'approved'];

/**
 * Rule-id prefix → human-readable category label. The prefix is the longest
 * leading snake-case stem of the rule_id, so `expired_promo_credit_v2` maps
 * the same as `expired_promo_credit`. Add new mappings here; unmatched ids
 * fall back to a Title-Cased version of the rule id.
 *
 * Keep this list close to the registry in `src/rules/definitions/`. See
 * agent reporting on the category-label map for rationale.
 */
const CATEGORY_LABEL_MAP: ReadonlyArray<readonly [string, string]> = [
  ['expired_promo_credit', 'Missing/expired promos'],
  ['account_promo_expiring_soon', 'Missing/expired promos'],
  ['completed_device_payment', 'Paid-off devices still billed'],
  ['dpp_exceeds_plan_base', 'Paid-off devices still billed'],
  ['duplicate_device_installment_same_line', 'Paid-off devices still billed'],
  ['orphan_insurance', 'Stale device protection'],
  ['insurance_after_device_payoff', 'Stale device protection'],
  ['duplicate_protection_features', 'Stale device protection'],
  ['stale_international_feature', 'Unused international features'],
  ['unused_mifi_line', 'Unused / zero-usage lines'],
  ['zero_usage_phone_line', 'Unused / zero-usage lines'],
  ['tablet_watch_with_zero_usage', 'Unused / zero-usage lines'],
  ['suspended_line_billed', 'Suspended lines still billed'],
  ['line_with_only_credits', 'Suspended lines still billed'],
  ['legacy_unlimited_plan', 'Plan optimization'],
  ['underutilized_phone_on_premium_plan', 'Plan optimization'],
  ['high_cost_low_usage_phone', 'Plan optimization'],
  ['data_overage_pattern', 'Plan optimization'],
  ['redundant_hotspot_addon', 'Redundant add-ons'],
  ['stranded_cloud_storage', 'Redundant add-ons'],
  ['feature_appears_on_majority_of_lines_under_one_dollar', 'Redundant add-ons'],
  ['feature_first_seen', 'New / unexpected charges'],
  ['activation_fee_on_existing_line', 'New / unexpected charges'],
  ['activation_fee_outsized', 'New / unexpected charges'],
  ['disproportionate_taxes_fees', 'Taxes & fees anomalies'],
  ['account_taxes_fees_low_anomaly', 'Taxes & fees anomalies'],
  ['account_total_mismatch', 'Bill totals & data quality'],
  ['unassigned_user_label', 'Bill totals & data quality'],
  ['line_charge_outlier_within_account', 'Bill totals & data quality'],
  ['bill_increase_over_threshold_in_total', 'Bill increase signals'],
  ['contract_rate_mismatch', 'Contract mismatches'],
  ['duplicate_charge_within_audit', 'Duplicate charges'],
  ['duplicate_charge_across_accounts', 'Duplicate charges'],
];

function titleCaseFallback(ruleId: string): string {
  return ruleId
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

/**
 * Map a rule_id to a category label. Matches the longest mapped prefix; if
 * nothing matches, returns a Title-Cased version of the id so unmapped
 * rules still render readably.
 */
export function categoryLabelForRule(ruleId: string): string {
  let bestMatch: { prefix: string; label: string } | null = null;
  for (const [prefix, label] of CATEGORY_LABEL_MAP) {
    if (ruleId === prefix || ruleId.startsWith(`${prefix}_`)) {
      if (!bestMatch || prefix.length > bestMatch.prefix.length) {
        bestMatch = { prefix, label };
      }
    }
  }
  if (bestMatch) return bestMatch.label;
  return titleCaseFallback(ruleId);
}

// ──────────────────────────────────────────────────────────────────────────
// Public input/output shapes
// ──────────────────────────────────────────────────────────────────────────

/** Row shape for `bill_comparisons` rows the builder consumes. */
export interface ExecutiveComparisonRow {
  id: string;
  previous_audit_id: string;
  current_audit_id: string;
  previous_total_cents: number;
  current_total_cents: number;
  net_change_cents: number;
  percent_change_bps: number | null;
}

/** Row shape for `bill_change_drivers` rows the builder consumes. */
export interface ExecutiveDriverRow {
  id: string;
  bill_comparison_id: string;
  category: string;
  title: string;
  difference_cents: number;
  affected_lines_count: number;
}

/** Row shape for `bill_lines` rows the builder consumes (cost-center only). */
export interface ExecutiveLineRow {
  audit_id: string;
  cost_center: string | null;
  plan_base_cents: number | null;
}

/**
 * Row shape for an audit row we want to summarize. A superset of
 * `ReportAuditRow` is fine — we only consume listed fields here.
 */
export type ExecutiveAuditRow = ReportAuditRow;

/** Row shape for a finding row. Mirrors `ReportFindingRow` (no extra cols). */
export type ExecutiveFindingRow = ReportFindingRow & { audit_id?: string };

export interface BuildExecutiveReportInput {
  /** Audits, newest first. The builder respects the caller's order. */
  audits: ExecutiveAuditRow[];
  /** All findings across those audits (any status). */
  findings: ExecutiveFindingRow[];
  /** All `bill_comparisons` whose endpoints are within `audits`. */
  comparisons: ExecutiveComparisonRow[];
  /** All `bill_change_drivers` belonging to the comparisons above. */
  drivers: ExecutiveDriverRow[];
  /** All `bill_lines` rows for the audits (cost-center + plan_base only). */
  billLines: ExecutiveLineRow[];
}

export interface ExecutiveAuditSummary {
  id: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  line_count: number;
  finding_count: number;
}

export interface ExecutiveLifetimeSummary {
  total_spend_cents: number;
  monthly_savings_cents: number;
  annual_savings_cents: number;
  finding_count_by_severity: Record<Severity, number>;
}

export interface ExecutiveTrendPoint {
  audit_id: string;
  billing_period_end: string | null;
  total_charges_cents: number;
  /**
   * Signed delta vs the previous (older) point in the trend, in basis
   * points (× 100). NULL on the oldest point (no prior to compare against)
   * AND when the prior total is 0 to avoid divide-by-zero.
   */
  percent_change_bps: number | null;
}

export interface ExecutiveTopFinding {
  audit_id: string | null;
  rule_id: string;
  severity: Severity;
  title: string;
  estimated_monthly_savings_cents: number;
  category_label: string;
}

export interface ExecutiveTopDriver {
  comparison_id: string;
  category: string;
  title: string;
  difference_cents: number;
  affected_lines_count: number;
}

export interface ExecutiveCategoryRow {
  category_label: string;
  finding_count: number;
  estimated_monthly_savings_cents: number;
}

export interface ExecutiveReportData {
  generatedFor: 'cfo';
  audits: ExecutiveAuditSummary[];
  lifetime: ExecutiveLifetimeSummary;
  /** Oldest → newest so the renderer can lay bars left-to-right. */
  trend: ExecutiveTrendPoint[];
  topFindings: ExecutiveTopFinding[];
  topAutopsyDrivers: ExecutiveTopDriver[];
  byCategory: ExecutiveCategoryRow[];
  /** NULL when no cost-center tags exist anywhere across the input. */
  byCostCenter: CostCenterRollupRow[] | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low', 'info'];

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

function isActionableStatus(value: unknown): boolean {
  if (value === null || value === undefined) {
    // DB default is 'new'; treat absent as actionable.
    return true;
  }
  return typeof value === 'string' && (ACTIONABLE_STATUSES as readonly string[]).includes(value);
}

function emptySeverityCounts(): Record<Severity, number> {
  return { high: 0, medium: 0, low: 0, info: 0 };
}

/**
 * Build the executive report data from raw rows. Deterministic given input.
 */
export function buildExecutiveReport(input: BuildExecutiveReportInput): ExecutiveReportData {
  const { audits, findings, comparisons, drivers, billLines } = input;

  // ── 1. Per-audit summaries (caller-provided order; newest first) ──────
  const audit_ids = new Set(audits.map((a) => a.id));
  const findingsCountByAudit = new Map<string, number>();
  for (const f of findings) {
    if (!f.audit_id) continue;
    findingsCountByAudit.set(f.audit_id, (findingsCountByAudit.get(f.audit_id) ?? 0) + 1);
  }
  const linesCountByAudit = new Map<string, number>();
  for (const line of billLines) {
    linesCountByAudit.set(line.audit_id, (linesCountByAudit.get(line.audit_id) ?? 0) + 1);
  }

  const auditSummaries: ExecutiveAuditSummary[] = audits.map((a) => ({
    id: a.id,
    carrier: a.carrier,
    billing_period_start: a.billing_period_start,
    billing_period_end: a.billing_period_end,
    total_charges_cents: a.total_charges_cents,
    line_count: a.line_count ?? linesCountByAudit.get(a.id) ?? 0,
    finding_count: a.finding_count ?? findingsCountByAudit.get(a.id) ?? 0,
  }));

  // ── 2. Lifetime aggregates ────────────────────────────────────────────
  let total_spend_cents = 0;
  let monthly_savings_cents = 0;
  let annual_savings_cents = 0;

  for (const a of audits) {
    total_spend_cents += a.total_charges_cents ?? 0;
    monthly_savings_cents += a.estimated_monthly_savings_cents ?? 0;
    annual_savings_cents += a.estimated_annual_savings_cents ?? 0;
  }

  const lifetime: ExecutiveLifetimeSummary = {
    total_spend_cents,
    monthly_savings_cents,
    annual_savings_cents,
    finding_count_by_severity: emptySeverityCounts(),
  };
  for (const f of findings) {
    if (!isSeverity(f.severity)) continue;
    lifetime.finding_count_by_severity[f.severity] += 1;
  }

  // ── 3. Trend (oldest → newest) ────────────────────────────────────────
  // Caller passes newest first. We render bars left-to-right oldest →
  // newest, so reverse here. Percent-change is signed delta vs the
  // immediately-prior bar (the older one to the left).
  const ordered = [...auditSummaries].reverse();
  const trend: ExecutiveTrendPoint[] = ordered.map((a, idx) => {
    const prior = idx > 0 ? ordered[idx - 1] : null;
    const priorTotal = prior?.total_charges_cents ?? null;
    const currTotal = a.total_charges_cents ?? 0;
    let pct: number | null = null;
    if (prior && priorTotal !== null && priorTotal !== 0) {
      pct = Math.round(((currTotal - priorTotal) / priorTotal) * 10_000);
    }
    return {
      audit_id: a.id,
      billing_period_end: a.billing_period_end,
      total_charges_cents: currTotal,
      percent_change_bps: pct,
    };
  });

  // ── 4. Top 5 findings (actionable only) ──────────────────────────────
  const topFindingsAll: ExecutiveTopFinding[] = [];
  for (const f of findings) {
    if (!isSeverity(f.severity)) continue;
    if (!isActionableStatus(f.status)) continue;
    topFindingsAll.push({
      audit_id: f.audit_id ?? null,
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      estimated_monthly_savings_cents: f.estimated_monthly_savings_cents,
      category_label: categoryLabelForRule(f.rule_id),
    });
  }
  topFindingsAll.sort((a, b) => {
    if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
      return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
    }
    return a.title.localeCompare(b.title);
  });
  const topFindings = topFindingsAll.slice(0, 5);

  // ── 5. Top 5 autopsy drivers by absolute |Δ|, only for comparisons
  //      whose endpoints are within the input audit set ────────────────
  const comparison_ids = new Set(
    comparisons
      .filter((c) => audit_ids.has(c.previous_audit_id) && audit_ids.has(c.current_audit_id))
      .map((c) => c.id),
  );
  const topDriversAll: ExecutiveTopDriver[] = drivers
    .filter((d) => comparison_ids.has(d.bill_comparison_id))
    .map((d) => ({
      comparison_id: d.bill_comparison_id,
      category: d.category,
      title: d.title,
      difference_cents: d.difference_cents,
      affected_lines_count: d.affected_lines_count,
    }));
  topDriversAll.sort((a, b) => {
    const ad = Math.abs(a.difference_cents);
    const bd = Math.abs(b.difference_cents);
    if (bd !== ad) return bd - ad;
    return a.title.localeCompare(b.title);
  });
  const topAutopsyDrivers = topDriversAll.slice(0, 5);

  // ── 6. By category (all findings, any status) ────────────────────────
  const categoryBuckets = new Map<
    string,
    { finding_count: number; estimated_monthly_savings_cents: number }
  >();
  for (const f of findings) {
    if (!isSeverity(f.severity)) continue;
    const label = categoryLabelForRule(f.rule_id);
    const bucket = categoryBuckets.get(label);
    if (bucket) {
      bucket.finding_count += 1;
      bucket.estimated_monthly_savings_cents += f.estimated_monthly_savings_cents;
    } else {
      categoryBuckets.set(label, {
        finding_count: 1,
        estimated_monthly_savings_cents: f.estimated_monthly_savings_cents,
      });
    }
  }
  const byCategory: ExecutiveCategoryRow[] = Array.from(categoryBuckets.entries())
    .map(([category_label, b]) => ({
      category_label,
      finding_count: b.finding_count,
      estimated_monthly_savings_cents: b.estimated_monthly_savings_cents,
    }))
    .sort((a, b) => {
      if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
        return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
      }
      return a.category_label.localeCompare(b.category_label);
    });

  // ── 7. By cost-center (NULL when no tagged lines exist anywhere) ─────
  const anyTagged = billLines.some((l) => l.cost_center !== null && l.cost_center.trim() !== '');
  let byCostCenter: CostCenterRollupRow[] | null = null;
  if (anyTagged) {
    const ccInput: CostCenterLineInput[] = billLines.map((l) => ({
      cost_center: l.cost_center,
      plan_base_cents: l.plan_base_cents,
    }));
    byCostCenter = aggregateCostCenters(ccInput);
  }

  return {
    generatedFor: 'cfo',
    audits: auditSummaries,
    lifetime,
    trend,
    topFindings,
    topAutopsyDrivers,
    byCategory,
    byCostCenter,
  };
}
