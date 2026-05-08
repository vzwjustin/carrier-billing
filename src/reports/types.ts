import type { Finding, Severity } from '@/rules/types';

/**
 * Shape of a row from the `audits` table that the report needs.
 * Mirrors the columns defined in CLAUDE.md §4. Keep this in sync.
 */
export interface ReportAuditRow {
  id: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  account_count: number | null;
  line_count: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  completed_at: string | null;
}

/** Row shape for `bill_accounts` joined to a per-account line count. */
export interface ReportAccountRow {
  id: string;
  audit_id: string;
  label: string | null;
  account_number_masked: string | null;
  total_charges_cents: number | null;
}

/** Row shape for `bill_lines` (only the columns the builder reads). */
export interface ReportLineRow {
  id: string;
  audit_id: string;
  account_id: string;
}

/** Row shape for `bill_features` (only what the builder reads). */
export interface ReportFeatureRow {
  id: string;
  line_id: string | null;
  audit_id: string;
}

/** Row shape for `bill_credits` (only what the builder reads). */
export interface ReportCreditRow {
  id: string;
  line_id: string | null;
  account_id: string | null;
  audit_id: string;
}

/** Row shape for `bill_dpp_installments` (only what the builder reads). */
export interface ReportDppInstallmentRow {
  id: string;
  line_id: string | null;
  audit_id: string;
}

/**
 * Row shape for the `findings` table. The viewer only needs these columns;
 * keep this aligned with §4 of CLAUDE.md.
 */
export interface ReportFindingRow {
  id: string;
  rule_id: string;
  severity: Severity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
  evidence: Record<string, unknown> | null;
}

/** Sub-shape exposed to the viewer for the audit summary block. */
export interface ReportAudit {
  id: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  account_count: number;
  line_count: number;
  finding_count: number;
  high_severity_count: number;
  estimated_monthly_savings_cents: number;
  estimated_annual_savings_cents: number;
  completed_at: string | null;
}

/** Sub-shape exposed to the viewer for the bill summary block. */
export interface ReportBillAccount {
  id: string;
  label: string | null;
  account_number_masked: string | null;
  total_charges_cents: number | null;
  lineCount: number;
}

export interface ReportBill {
  accounts: ReportBillAccount[];
}

/**
 * The complete view-friendly shape the report renderer consumes. Built
 * once on the server, then handed to React server components.
 *
 * `Finding` rows in `findingsBySeverity` are sorted by
 * `estimated_monthly_savings_cents` descending. Severity buckets that
 * have no findings are still present (empty array) so consumers can
 * iterate them in a stable order.
 */
export interface ReportData {
  audit: ReportAudit;
  findingsBySeverity: Record<Severity, Finding[]>;
  bill: ReportBill;
}

/** Convenience export so other modules can use it without re-importing. */
export type { Finding, Severity } from '@/rules/types';
