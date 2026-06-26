import { describe, expect, it } from 'vitest';

import { optimizeBill, validateBill } from '@/lib/carriers/optimize';
import type { LineItem } from '@/lib/carriers/bill-schema';

function li(over: Partial<LineItem> = {}): LineItem {
  return {
    id: over.id ?? crypto.randomUUID(),
    description: over.description ?? 'Line',
    monthlyCents: over.monthlyCents ?? 5000,
    optimizedCents: over.optimizedCents ?? 5000,
  };
}

describe('optimizeBill — generic rules', () => {
  it('flags duplicate device protection but keeps the first', () => {
    const items = [
      li({ id: 'a', description: 'Device Protection', monthlyCents: 1700 }),
      li({ id: 'b', description: 'Device protection plan', monthlyCents: 1700 }),
    ];
    const { suggestions } = optimizeBill('verizon', items);
    const dup = suggestions.filter((s) => s.ruleId === 'duplicate_device_protection');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.lineItemId).toBe('b');
    expect(dup[0]?.suggestedCents).toBe(0);
  });

  it('does NOT flag a single device-protection line', () => {
    const { suggestions } = optimizeBill('verizon', [
      li({ description: 'Device Protection', monthlyCents: 1700 }),
    ]);
    expect(suggestions.some((s) => s.ruleId === 'duplicate_device_protection')).toBe(false);
  });

  it('suggests stepping down an over-provisioned premium unlimited tier', () => {
    const { suggestions, projectedSavingsCents } = optimizeBill('att', [
      li({ id: 'p', description: 'Unlimited Premium', monthlyCents: 9500 }),
    ]);
    const s = suggestions.find((x) => x.ruleId === 'premium_unlimited_overprovisioned');
    expect(s?.suggestedCents).toBe(8000);
    expect(projectedSavingsCents).toBe(1500);
  });

  it('does not flag a standard unlimited plan under threshold', () => {
    const { suggestions } = optimizeBill('att', [
      li({ description: 'Unlimited Premium', monthlyCents: 8500 }),
    ]);
    expect(suggestions).toHaveLength(0);
  });
});

describe('optimizeBill — carrier-specific rules', () => {
  it('flags Verizon Cloud only for verizon', () => {
    const items = [li({ description: 'Verizon Cloud 600GB', monthlyCents: 1000 })];
    expect(
      optimizeBill('verizon', items).suggestions.some((s) => s.ruleId === 'verizon_cloud_unused'),
    ).toBe(true);
    expect(
      optimizeBill('tmobile', items).suggestions.some((s) => s.ruleId === 'verizon_cloud_unused'),
    ).toBe(false);
  });

  it('flags AT&T Next Up and T-Mobile bundled streaming', () => {
    expect(
      optimizeBill('att', [
        li({ description: 'Next Up upgrade', monthlyCents: 600 }),
      ]).suggestions.some((s) => s.ruleId === 'att_nextup_optional'),
    ).toBe(true);
    expect(
      optimizeBill('tmobile', [
        li({ description: 'Netflix on Us', monthlyCents: 1549 }),
      ]).suggestions.some((s) => s.ruleId === 'tmobile_bundled_streaming_duplicate'),
    ).toBe(true);
  });
});

describe('validateBill', () => {
  it('errors on empty description and negative amount', () => {
    const issues = validateBill('verizon', [
      li({ id: 'x', description: '   ', monthlyCents: -100 }),
    ]);
    const ruleIds = issues.map((i) => i.ruleId);
    expect(ruleIds).toContain('empty_description');
    expect(ruleIds).toContain('negative_amount');
  });

  it('warns when optimized exceeds current', () => {
    const issues = validateBill('att', [li({ monthlyCents: 1000, optimizedCents: 2000 })]);
    expect(issues.some((i) => i.ruleId === 'optimized_exceeds_current')).toBe(true);
  });

  it('applies a lower carrier ceiling for T-Mobile', () => {
    const big = [li({ monthlyCents: 45000 })];
    expect(
      validateBill('tmobile', big).some((i) => i.ruleId === 'amount_exceeds_carrier_ceiling'),
    ).toBe(true);
    expect(
      validateBill('verizon', big).some((i) => i.ruleId === 'amount_exceeds_carrier_ceiling'),
    ).toBe(false);
  });

  it('passes a clean bill', () => {
    const result = optimizeBill('verizon', [
      li({ description: 'Line 1', monthlyCents: 4000, optimizedCents: 4000 }),
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
    expect(result.projectedSavingsCents).toBe(0);
  });
});
