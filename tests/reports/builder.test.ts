import { describe, expect, it } from 'vitest';

import { buildReportData } from '@/reports/builder';
import type {
  ReportAccountRow,
  ReportAuditRow,
  ReportCreditRow,
  ReportDppInstallmentRow,
  ReportFeatureRow,
  ReportFindingRow,
  ReportLineRow,
} from '@/reports/types';

function makeAudit(overrides: Partial<ReportAuditRow> = {}): ReportAuditRow {
  return {
    id: 'audit-1',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 250_000,
    account_count: 2,
    line_count: 5,
    finding_count: 4,
    high_severity_count: 2,
    estimated_monthly_savings_cents: 4500,
    estimated_annual_savings_cents: 4500 * 12,
    completed_at: '2026-04-30T00:00:00Z',
    ...overrides,
  };
}

function makeFinding(
  overrides: Partial<ReportFindingRow> & Pick<ReportFindingRow, 'id' | 'severity'>,
): ReportFindingRow {
  return {
    rule_id: 'test_rule',
    title: 'Test',
    description: 'Test description',
    recommended_action: 'Test action',
    estimated_monthly_savings_cents: 0,
    confidence: 0.9,
    affected_line_ids: [],
    affected_account_ids: [],
    evidence: {},
    ...overrides,
  };
}

const noBillRows = {
  features: [] as ReportFeatureRow[],
  credits: [] as ReportCreditRow[],
  dppInstallments: [] as ReportDppInstallmentRow[],
};

describe('buildReportData', () => {
  it('groups findings by severity', () => {
    const findings: ReportFindingRow[] = [
      makeFinding({ id: 'f1', severity: 'high', title: 'High A' }),
      makeFinding({ id: 'f2', severity: 'medium', title: 'Med A' }),
      makeFinding({ id: 'f3', severity: 'low', title: 'Low A' }),
      makeFinding({ id: 'f4', severity: 'info', title: 'Info A' }),
      makeFinding({ id: 'f5', severity: 'high', title: 'High B' }),
    ];

    const report = buildReportData({
      audit: makeAudit(),
      findings,
      accounts: [],
      lines: [],
      ...noBillRows,
    });

    expect(report.findingsBySeverity.high.length).toBe(2);
    expect(report.findingsBySeverity.medium.length).toBe(1);
    expect(report.findingsBySeverity.low.length).toBe(1);
    expect(report.findingsBySeverity.info.length).toBe(1);
  });

  it('sorts findings within a severity by estimated_monthly_savings_cents desc', () => {
    const findings: ReportFindingRow[] = [
      makeFinding({
        id: 'f1',
        severity: 'high',
        title: 'cheap',
        estimated_monthly_savings_cents: 1000,
      }),
      makeFinding({
        id: 'f2',
        severity: 'high',
        title: 'expensive',
        estimated_monthly_savings_cents: 9000,
      }),
      makeFinding({
        id: 'f3',
        severity: 'high',
        title: 'medium',
        estimated_monthly_savings_cents: 5000,
      }),
    ];

    const report = buildReportData({
      audit: makeAudit(),
      findings,
      accounts: [],
      lines: [],
      ...noBillRows,
    });

    const high = report.findingsBySeverity.high;
    expect(high.map((f) => f.title)).toEqual(['expensive', 'medium', 'cheap']);
  });

  it('returns empty arrays for all severities when there are no findings', () => {
    const report = buildReportData({
      audit: makeAudit({ finding_count: 0, high_severity_count: 0 }),
      findings: [],
      accounts: [],
      lines: [],
      ...noBillRows,
    });

    expect(report.findingsBySeverity.high).toEqual([]);
    expect(report.findingsBySeverity.medium).toEqual([]);
    expect(report.findingsBySeverity.low).toEqual([]);
    expect(report.findingsBySeverity.info).toEqual([]);
  });

  it('passes audit fields through to the report', () => {
    const audit = makeAudit({
      id: 'aud-xyz',
      carrier: 'att',
      total_charges_cents: 99_99,
      finding_count: 7,
      high_severity_count: 3,
      estimated_monthly_savings_cents: 12_345,
      estimated_annual_savings_cents: 12_345 * 12,
    });

    const report = buildReportData({
      audit,
      findings: [],
      accounts: [],
      lines: [],
      ...noBillRows,
    });

    expect(report.audit.id).toBe('aud-xyz');
    expect(report.audit.carrier).toBe('att');
    expect(report.audit.total_charges_cents).toBe(99_99);
    expect(report.audit.finding_count).toBe(7);
    expect(report.audit.high_severity_count).toBe(3);
    expect(report.audit.estimated_monthly_savings_cents).toBe(12_345);
    expect(report.audit.estimated_annual_savings_cents).toBe(12_345 * 12);
  });

  it('computes per-account line counts from bill_lines rows', () => {
    const accounts: ReportAccountRow[] = [
      {
        id: 'acc-1',
        audit_id: 'audit-1',
        label: 'Main',
        account_number_masked: '1234',
        total_charges_cents: 100_000,
      },
      {
        id: 'acc-2',
        audit_id: 'audit-1',
        label: 'Branch',
        account_number_masked: '5678',
        total_charges_cents: 50_000,
      },
    ];
    const lines: ReportLineRow[] = [
      { id: 'l1', audit_id: 'audit-1', account_id: 'acc-1' },
      { id: 'l2', audit_id: 'audit-1', account_id: 'acc-1' },
      { id: 'l3', audit_id: 'audit-1', account_id: 'acc-2' },
    ];

    const report = buildReportData({
      audit: makeAudit(),
      findings: [],
      accounts,
      lines,
      ...noBillRows,
    });

    expect(report.bill.accounts).toHaveLength(2);
    expect(report.bill.accounts[0]?.lineCount).toBe(2);
    expect(report.bill.accounts[1]?.lineCount).toBe(1);
  });

  it('drops findings with unknown severity values', () => {
    const findings: ReportFindingRow[] = [
      makeFinding({
        id: 'f1',
        severity: 'high',
        title: 'kept',
      }),
      makeFinding({
        id: 'f2',
        // intentionally bad severity
        severity: 'critical' as unknown as ReportFindingRow['severity'],
        title: 'dropped',
      }),
    ];

    const report = buildReportData({
      audit: makeAudit(),
      findings,
      accounts: [],
      lines: [],
      ...noBillRows,
    });

    expect(report.findingsBySeverity.high.map((f) => f.title)).toEqual(['kept']);
  });
});
