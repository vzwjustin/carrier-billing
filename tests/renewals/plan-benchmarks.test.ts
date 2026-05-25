import { describe, expect, it } from 'vitest';

import {
  benchmarkPlans,
  type BillLineRow,
} from '@/lib/renewals/plan-benchmarks';

describe('benchmarkPlans', () => {
  it('returns an empty array when given no lines', () => {
    expect(benchmarkPlans([])).toEqual([]);
  });

  it('returns an empty array when no line matches a legacy plan', () => {
    const lines: BillLineRow[] = [
      {
        carrier: 'verizon',
        plan_name: 'Business Unlimited Plus 2.0',
        plan_base_cents: 4500,
      },
      {
        carrier: 'tmobile',
        plan_name: 'Business Unlimited Advanced',
        plan_base_cents: 4000,
      },
      // Null plan_name should be skipped entirely.
      { carrier: 'att', plan_name: null, plan_base_cents: 5000 },
    ];
    expect(benchmarkPlans(lines)).toEqual([]);
  });

  it('aggregates carrier-scoped lines matching a single legacy plan', () => {
    // Three Verizon lines on the legacy "More Everything" plan, plus an
    // unrelated current-plan line that must not affect the count.
    const lines: BillLineRow[] = [
      {
        carrier: 'verizon',
        plan_name: 'More Everything',
        plan_base_cents: 6000,
      },
      {
        carrier: 'verizon',
        plan_name: 'More Everything',
        plan_base_cents: 7000,
      },
      {
        carrier: 'verizon',
        plan_name: 'More Everything',
        plan_base_cents: 8000,
      },
      {
        carrier: 'verizon',
        plan_name: 'Business Unlimited Plus 2.0',
        plan_base_cents: 5000,
      },
    ];
    const result = benchmarkPlans(lines);
    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row).toBeDefined();
    expect(row?.carrier).toBe('verizon');
    expect(row?.replacement_plan).toBe('Business Unlimited Plus 2.0');
    expect(row?.line_count).toBe(3);
    // (6000 + 7000 + 8000) / 3 = 7000
    expect(row?.current_avg_monthly_cents).toBe(7000);
    // Per-line savings for More Everything = $10.00 = 1000 cents.
    expect(row?.estimated_per_line_savings_cents).toBe(1000);
    expect(row?.estimated_monthly_savings_cents).toBe(3000);
    expect(row?.estimated_annual_savings_cents).toBe(36_000);
  });

  it('keeps carriers separated even when their legacy patterns share text', () => {
    // AT&T "Unlimited Plus" and Spectrum "Unlimited Plus" are different
    // legacy entries — they should produce two separate benchmark rows
    // even though the plan name text is identical.
    const lines: BillLineRow[] = [
      {
        carrier: 'att',
        plan_name: 'Unlimited Plus',
        plan_base_cents: 5000,
      },
      {
        carrier: 'spectrum',
        plan_name: 'Unlimited Plus',
        plan_base_cents: 4500,
      },
      // Throw in a T-Mobile Magenta line to confirm cross-carrier matching
      // doesn't bleed into the AT&T/Spectrum buckets.
      {
        carrier: 'tmobile',
        plan_name: 'Magenta',
        plan_base_cents: 5500,
      },
    ];
    const result = benchmarkPlans(lines);
    expect(result).toHaveLength(3);
    const carriers = result.map((r) => r.carrier).sort();
    expect(carriers).toEqual(['att', 'spectrum', 'tmobile']);
    // Each carrier bucket has exactly one line.
    for (const row of result) {
      expect(row.line_count).toBe(1);
    }
  });

  it('sorts benchmark rows by estimated monthly savings descending', () => {
    // Build a mix where AT&T Mobile Share (1000 / line × 2 lines = 2000)
    // is the biggest bucket, T-Mobile Magenta (700 × 2 = 1400) sits in the
    // middle, and Verizon Single Line Plan (700 × 1 = 700) trails.
    const lines: BillLineRow[] = [
      {
        carrier: 'att',
        plan_name: 'Mobile Share',
        plan_base_cents: 6000,
      },
      {
        carrier: 'att',
        plan_name: 'Mobile Share',
        plan_base_cents: 7000,
      },
      {
        carrier: 'tmobile',
        plan_name: 'Magenta',
        plan_base_cents: 5000,
      },
      {
        carrier: 'tmobile',
        plan_name: 'Magenta',
        plan_base_cents: 6000,
      },
      {
        carrier: 'verizon',
        plan_name: 'Single Line Plan',
        plan_base_cents: 4500,
      },
    ];
    const result = benchmarkPlans(lines);
    expect(result.map((r) => r.carrier)).toEqual([
      'att',
      'tmobile',
      'verizon',
    ]);
    expect(result.map((r) => r.estimated_monthly_savings_cents)).toEqual([
      2000, 1400, 700,
    ]);
  });

});
