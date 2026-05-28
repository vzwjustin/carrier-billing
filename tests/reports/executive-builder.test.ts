import { describe, expect, it } from 'vitest';

import {
  buildExecutiveReport,
  categoryLabelForRule,
  type ExecutiveAuditRow,
  type ExecutiveComparisonRow,
  type ExecutiveDriverRow,
  type ExecutiveFindingRow,
  type ExecutiveLineRow,
} from '@/reports/executive/builder';

function makeAudit(overrides: Partial<ExecutiveAuditRow> = {}): ExecutiveAuditRow {
  return {
    id: 'audit-1',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 100_000,
    account_count: 1,
    line_count: 3,
    finding_count: 0,
    high_severity_count: 0,
    estimated_monthly_savings_cents: 0,
    estimated_annual_savings_cents: 0,
    completed_at: '2026-04-30T00:00:00Z',
    ...overrides,
  };
}

function makeFinding(
  overrides: Partial<ExecutiveFindingRow> &
    Pick<ExecutiveFindingRow, 'id' | 'severity' | 'rule_id'>,
): ExecutiveFindingRow {
  return {
    title: 'Default title',
    description: 'Default description',
    recommended_action: 'Default action',
    estimated_monthly_savings_cents: 0,
    confidence: 0.9,
    affected_line_ids: [],
    affected_account_ids: [],
    evidence: {},
    status: 'new',
    ...overrides,
  };
}

describe('buildExecutiveReport', () => {
  it('handles empty input', () => {
    const data = buildExecutiveReport({
      audits: [],
      findings: [],
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    expect(data.generatedFor).toBe('cfo');
    expect(data.audits).toEqual([]);
    expect(data.lifetime).toEqual({
      total_spend_cents: 0,
      monthly_savings_cents: 0,
      annual_savings_cents: 0,
      finding_count_by_severity: { high: 0, medium: 0, low: 0, info: 0 },
    });
    expect(data.trend).toEqual([]);
    expect(data.topFindings).toEqual([]);
    expect(data.topAutopsyDrivers).toEqual([]);
    expect(data.byCategory).toEqual([]);
    expect(data.byCostCenter).toBeNull();
  });

  it('aggregates lifetime totals across audits', () => {
    const audits: ExecutiveAuditRow[] = [
      makeAudit({
        id: 'a3',
        billing_period_end: '2026-06-30',
        total_charges_cents: 300_000,
        estimated_monthly_savings_cents: 500,
        estimated_annual_savings_cents: 6_000,
      }),
      makeAudit({
        id: 'a2',
        billing_period_end: '2026-05-31',
        total_charges_cents: 200_000,
        estimated_monthly_savings_cents: 400,
        estimated_annual_savings_cents: 4_800,
      }),
      makeAudit({
        id: 'a1',
        billing_period_end: '2026-04-30',
        total_charges_cents: 100_000,
        estimated_monthly_savings_cents: 300,
        estimated_annual_savings_cents: 3_600,
      }),
    ];

    const data = buildExecutiveReport({
      audits,
      findings: [],
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    expect(data.lifetime.total_spend_cents).toBe(600_000);
    expect(data.lifetime.monthly_savings_cents).toBe(1_200);
    expect(data.lifetime.annual_savings_cents).toBe(14_400);
    // Trend renders oldest → newest.
    expect(data.trend.map((p) => p.audit_id)).toEqual(['a1', 'a2', 'a3']);
    // Percent deltas: null on oldest, +100% then +50%.
    expect(data.trend[0]?.percent_change_bps).toBeNull();
    expect(data.trend[1]?.percent_change_bps).toBe(10_000);
    expect(data.trend[2]?.percent_change_bps).toBe(5_000);
  });

  it('single audit reports no autopsy and one trend point', () => {
    const data = buildExecutiveReport({
      audits: [
        makeAudit({
          id: 'solo',
          estimated_monthly_savings_cents: 1_000,
          estimated_annual_savings_cents: 12_000,
        }),
      ],
      findings: [],
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    expect(data.audits).toHaveLength(1);
    expect(data.trend).toHaveLength(1);
    expect(data.trend[0]?.percent_change_bps).toBeNull();
    expect(data.topAutopsyDrivers).toEqual([]);
  });

  it('includes autopsy drivers across multiple audits, sorted by |Δ|', () => {
    const audits = [
      makeAudit({ id: 'cur', total_charges_cents: 200_000 }),
      makeAudit({ id: 'prev', total_charges_cents: 100_000 }),
    ];
    const comparisons: ExecutiveComparisonRow[] = [
      {
        id: 'cmp1',
        previous_audit_id: 'prev',
        current_audit_id: 'cur',
        previous_total_cents: 100_000,
        current_total_cents: 200_000,
        net_change_cents: 100_000,
        percent_change_bps: 10_000,
      },
    ];
    const drivers: ExecutiveDriverRow[] = [
      {
        id: 'd1',
        bill_comparison_id: 'cmp1',
        category: 'missing_credits',
        title: 'Lost credit',
        difference_cents: 5_000,
        affected_lines_count: 3,
      },
      {
        id: 'd2',
        bill_comparison_id: 'cmp1',
        category: 'new_lines',
        title: 'New lines added',
        difference_cents: 9_000,
        affected_lines_count: 2,
      },
      {
        id: 'd3',
        bill_comparison_id: 'cmp1',
        category: 'device_installments_removed',
        title: 'DPP ended',
        difference_cents: -7_500,
        affected_lines_count: 1,
      },
    ];
    // A driver that points to a comparison whose endpoints are outside the
    // input audits — must be excluded.
    const orphanComparison: ExecutiveComparisonRow = {
      id: 'cmp-orphan',
      previous_audit_id: 'foreign',
      current_audit_id: 'cur',
      previous_total_cents: 0,
      current_total_cents: 0,
      net_change_cents: 0,
      percent_change_bps: null,
    };
    const orphanDriver: ExecutiveDriverRow = {
      id: 'd-orphan',
      bill_comparison_id: 'cmp-orphan',
      category: 'unexplained',
      title: 'should not appear',
      difference_cents: 999_999,
      affected_lines_count: 0,
    };

    const data = buildExecutiveReport({
      audits,
      findings: [],
      comparisons: [...comparisons, orphanComparison],
      drivers: [...drivers, orphanDriver],
      billLines: [],
    });

    expect(data.topAutopsyDrivers).toHaveLength(3);
    // Sorted by absolute difference desc: 9_000, 7_500, 5_000.
    expect(data.topAutopsyDrivers.map((d) => d.title)).toEqual([
      'New lines added',
      'DPP ended',
      'Lost credit',
    ]);
  });

  it('bucketizes findings into category labels using rule_id prefix', () => {
    const audits = [makeAudit({ id: 'a1' })];
    const findings: ExecutiveFindingRow[] = [
      makeFinding({
        id: 'f1',
        severity: 'high',
        rule_id: 'expired_promo_credit',
        title: 'Promo',
        estimated_monthly_savings_cents: 2_000,
      }),
      makeFinding({
        id: 'f2',
        severity: 'high',
        rule_id: 'account_promo_expiring_soon',
        title: 'Promo soon',
        estimated_monthly_savings_cents: 500,
      }),
      makeFinding({
        id: 'f3',
        severity: 'medium',
        rule_id: 'completed_device_payment',
        title: 'DPP done',
        estimated_monthly_savings_cents: 1_500,
      }),
      makeFinding({
        id: 'f4',
        severity: 'low',
        rule_id: 'some_brand_new_rule_we_have_not_mapped',
        title: 'Unmapped',
        estimated_monthly_savings_cents: 100,
      }),
    ];

    const data = buildExecutiveReport({
      audits,
      findings,
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    const labels = data.byCategory.map((r) => r.category_label);
    // Top bucket by savings is "Missing/expired promos" (2_000 + 500).
    expect(labels[0]).toBe('Missing/expired promos');
    const promos = data.byCategory.find(
      (r) => r.category_label === 'Missing/expired promos',
    );
    expect(promos?.estimated_monthly_savings_cents).toBe(2_500);
    expect(promos?.finding_count).toBe(2);

    // The unmapped rule falls back to a Title-Cased label.
    expect(labels).toContain('Some Brand New Rule We Have Not Mapped');
    expect(data.lifetime.finding_count_by_severity).toEqual({
      high: 2,
      medium: 1,
      low: 1,
      info: 0,
    });
  });

  it('only considers actionable finding statuses in topFindings', () => {
    const audits = [makeAudit({ id: 'a1' })];
    const findings: ExecutiveFindingRow[] = [
      makeFinding({
        id: 'f1',
        severity: 'high',
        rule_id: 'expired_promo_credit',
        title: 'Actionable',
        estimated_monthly_savings_cents: 9_000,
        status: 'new',
      }),
      makeFinding({
        id: 'f2',
        severity: 'high',
        rule_id: 'completed_device_payment',
        title: 'Rejected',
        estimated_monthly_savings_cents: 99_999,
        status: 'rejected',
      }),
      makeFinding({
        id: 'f3',
        severity: 'medium',
        rule_id: 'orphan_insurance',
        title: 'In review',
        estimated_monthly_savings_cents: 3_000,
        status: 'in_review',
      }),
    ];

    const data = buildExecutiveReport({
      audits,
      findings,
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    expect(data.topFindings.map((f) => f.title)).toEqual([
      'Actionable',
      'In review',
    ]);
  });

  it('truncates top findings and top drivers to 5', () => {
    const audits = [makeAudit({ id: 'a1' })];
    const findings: ExecutiveFindingRow[] = Array.from(
      { length: 8 },
      (_, i) =>
        makeFinding({
          id: `f${i}`,
          severity: 'high',
          rule_id: 'expired_promo_credit',
          title: `Finding ${i}`,
          estimated_monthly_savings_cents: (8 - i) * 1_000,
        }),
    );

    const data = buildExecutiveReport({
      audits,
      findings,
      comparisons: [],
      drivers: [],
      billLines: [],
    });

    expect(data.topFindings).toHaveLength(5);
    // Sorted by savings desc.
    expect(data.topFindings[0]?.estimated_monthly_savings_cents).toBe(8_000);
    expect(data.topFindings[4]?.estimated_monthly_savings_cents).toBe(4_000);
  });

  it('returns null byCostCenter when no lines are tagged', () => {
    const audits = [makeAudit({ id: 'a1' })];
    const billLines: ExecutiveLineRow[] = [
      { audit_id: 'a1', cost_center: null, plan_base_cents: 1_000 },
      { audit_id: 'a1', cost_center: '   ', plan_base_cents: 2_000 },
    ];

    const data = buildExecutiveReport({
      audits,
      findings: [],
      comparisons: [],
      drivers: [],
      billLines,
    });

    expect(data.byCostCenter).toBeNull();
  });

  it('rolls untagged cost-center lines under "(unassigned)"', () => {
    const audits = [makeAudit({ id: 'a1' })];
    const billLines: ExecutiveLineRow[] = [
      { audit_id: 'a1', cost_center: 'Engineering', plan_base_cents: 6_000 },
      { audit_id: 'a1', cost_center: 'Engineering', plan_base_cents: 4_000 },
      { audit_id: 'a1', cost_center: null, plan_base_cents: 2_000 },
      { audit_id: 'a1', cost_center: '', plan_base_cents: 1_000 },
    ];

    const data = buildExecutiveReport({
      audits,
      findings: [],
      comparisons: [],
      drivers: [],
      billLines,
    });

    expect(data.byCostCenter).not.toBeNull();
    const labels = (data.byCostCenter ?? []).map((r) => r.cost_center);
    expect(labels).toContain('Engineering');
    expect(labels).toContain('(unassigned)');
    const eng = data.byCostCenter?.find((r) => r.cost_center === 'Engineering');
    expect(eng?.monthly_total_cents).toBe(10_000);
    expect(eng?.line_count).toBe(2);
    const unassigned = data.byCostCenter?.find(
      (r) => r.cost_center === '(unassigned)',
    );
    expect(unassigned?.monthly_total_cents).toBe(3_000);
    expect(unassigned?.line_count).toBe(2);
  });
});

describe('categoryLabelForRule', () => {
  it('matches the longest known prefix', () => {
    expect(categoryLabelForRule('expired_promo_credit')).toBe(
      'Missing/expired promos',
    );
    expect(categoryLabelForRule('expired_promo_credit_v2')).toBe(
      'Missing/expired promos',
    );
    expect(categoryLabelForRule('account_promo_expiring_soon')).toBe(
      'Missing/expired promos',
    );
  });

  it('falls back to Title Case for unmapped rule ids', () => {
    expect(categoryLabelForRule('brand_new_rule')).toBe('Brand New Rule');
  });
});
