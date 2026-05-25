import type { Finding, FindingStatus, Severity } from '@/rules/types';

const FINDING_STATUSES: readonly FindingStatus[] = [
  'new',
  'in_review',
  'approved',
  'rejected',
  'disputed',
  'resolved',
];

function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === 'string' && FINDING_STATUSES.includes(value as FindingStatus);
}

import type {
  ReportAccountRow,
  ReportAudit,
  ReportAuditRow,
  ReportBillAccount,
  ReportCreditRow,
  ReportData,
  ReportDppInstallmentRow,
  ReportFeatureRow,
  ReportFindingRow,
  ReportLineRow,
} from './types';

const SEVERITY_ORDER: readonly Severity[] = ['high', 'medium', 'low', 'info'];

function emptyBuckets(): Record<Severity, Finding[]> {
  return {
    high: [],
    medium: [],
    low: [],
    info: [],
  };
}

function isSeverity(value: string): value is Severity {
  return SEVERITY_ORDER.includes(value as Severity);
}

/**
 * Convert a raw findings DB row into the `Finding` shape used by the
 * report viewer. We keep things conservative — unknown severities are
 * dropped (logged as null and filtered upstream).
 */
function rowToFinding(row: ReportFindingRow): Finding | null {
  if (!isSeverity(row.severity)) return null;
  const lineIds = row.affected_line_ids ?? [];
  // The runtime Finding type uses 0-based indexes; the DB stores UUIDs.
  // For the report viewer we only need the COUNT (per the spec's PII
  // discipline — we never render the actual line UUIDs). We surface the
  // count via the length of `affected_line_indexes` so downstream
  // components can rely on a single field name.
  return {
    id: row.id,
    rule_id: row.rule_id,
    severity: row.severity,
    title: row.title,
    description: row.description,
    recommended_action: row.recommended_action,
    estimated_monthly_savings_cents: row.estimated_monthly_savings_cents,
    confidence: row.confidence,
    affected_line_indexes: lineIds.map((_, i) => i),
    affected_account_indexes: (row.affected_account_ids ?? []).map((_, i) => i),
    evidence: row.evidence ?? {},
    status: isFindingStatus(row.status) ? row.status : 'new',
  };
}

export interface BuildReportInput {
  audit: ReportAuditRow;
  findings: ReportFindingRow[];
  accounts: ReportAccountRow[];
  lines: ReportLineRow[];
  features: ReportFeatureRow[];
  credits: ReportCreditRow[];
  dppInstallments: ReportDppInstallmentRow[];
}

/**
 * Pure, deterministic transformer from raw DB rows into the shape the
 * report viewer renders. No I/O, no time, no env reads — it's safe to
 * snapshot in tests.
 */
export function buildReportData(input: BuildReportInput): ReportData {
  const { audit, findings, accounts, lines } = input;

  // Group findings by severity, sorted within each bucket by monthly
  // savings (descending). Same-savings ties fall back to title for a
  // stable order.
  const bySeverity = emptyBuckets();
  for (const row of findings) {
    const f = rowToFinding(row);
    if (!f) continue;
    const bucket = bySeverity[f.severity];
    bucket.push(f);
  }
  for (const sev of SEVERITY_ORDER) {
    const bucket = bySeverity[sev];
    bucket.sort((a, b) => {
      if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
        return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
      }
      return a.title.localeCompare(b.title);
    });
  }

  // Per-account line counts.
  const linesPerAccount = new Map<string, number>();
  for (const line of lines) {
    linesPerAccount.set(line.account_id, (linesPerAccount.get(line.account_id) ?? 0) + 1);
  }

  const reportAccounts: ReportBillAccount[] = accounts.map((a) => ({
    id: a.id,
    label: a.account_label,
    account_number_masked: a.account_number_masked,
    total_charges_cents: a.total_charges_cents,
    lineCount: linesPerAccount.get(a.id) ?? 0,
  }));

  const reportAudit: ReportAudit = {
    id: audit.id,
    carrier: audit.carrier,
    billing_period_start: audit.billing_period_start,
    billing_period_end: audit.billing_period_end,
    total_charges_cents: audit.total_charges_cents,
    account_count: audit.account_count ?? accounts.length,
    line_count: audit.line_count ?? lines.length,
    finding_count: audit.finding_count ?? findings.length,
    high_severity_count: audit.high_severity_count ?? bySeverity.high.length,
    estimated_monthly_savings_cents: audit.estimated_monthly_savings_cents ?? 0,
    estimated_annual_savings_cents: audit.estimated_annual_savings_cents ?? 0,
    completed_at: audit.completed_at,
  };

  return {
    audit: reportAudit,
    findingsBySeverity: bySeverity,
    bill: { accounts: reportAccounts },
  };
}

export { SEVERITY_ORDER };
