import { describe, expect, it, vi } from 'vitest';
import { disproportionateTaxesFeesRule } from '@/rules/definitions/disproportionate-taxes-fees';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, TEST_TODAY } from './fixtures';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('disproportionate_taxes_fees rule', () => {
  it('fires when taxes+fees exceed 25% of pre-tax charges', async () => {
    // pre-tax = 40000 - 12000 = 28000; ratio = 12000/28000 ≈ 0.428 (≥ 0.25).
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 40000,
          taxes_fees_cents: 12000,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    // M6: dollar figure surfaced via evidence; monthly rollup stays at 0.
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.confidence).toBe(0.5);
    expect(f.affected_line_indexes).toEqual([]);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.evidence?.taxes_fees_cents).toBe(12000);
    expect(f.evidence?.pre_tax_cents).toBe(28000);
    expect(f.evidence?.ratio).toBeCloseTo(0.429, 2);
    // potential credit = 12000 - 28000*0.22 = 12000 - 6160 = 5840.
    expect(f.evidence?.potential_monthly_credit_cents).toBe(5840);
  });

  it('does NOT fire when taxes+fees ratio is under 25%', async () => {
    // pre-tax = 50000 - 5000 = 45000; ratio = 5000/45000 ≈ 0.111.
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 5000,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when fees fall below the $10 noise floor', async () => {
    // Ratio would be 500/1000 = 50%, but $5 < MIN_FEES_CENTS = $10.
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 1500,
          taxes_fees_cents: 500,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when total charges are zero or negative (credit-only month)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 0,
          taxes_fees_cents: 5000,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when fees equal or exceed total (pre-tax would be <= 0)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 5000,
          taxes_fees_cents: 5000,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('handles null taxes_fees_cents as zero (and therefore skips)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: null,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('clamps excess to zero when expected band already exceeds reported fees', async () => {
    // Edge case at exactly the 25% boundary: ratio = 25% means fees are
    // ABOVE the 22% expected band, so excess should be > 0. But test with
    // ratio just barely above to ensure we don't go negative.
    const c = ctx({
      accounts: [
        makeAccount({
          // pre-tax = 10000 - 2501 = 7499; ratio = 2501/7499 ≈ 0.333.
          total_charges_cents: 10000,
          taxes_fees_cents: 2501,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.evidence?.potential_monthly_credit_cents).toBeGreaterThanOrEqual(0);
  });

  it('fires once per qualifying account on a multi-account bill', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          total_charges_cents: 40000,
          taxes_fees_cents: 12000,
        }),
        makeAccount({
          account_number_last4: '2222',
          total_charges_cents: 40000,
          taxes_fees_cents: 12000,
        }),
        makeAccount({
          account_number_last4: '3333',
          // This account is fine.
          total_charges_cents: 50000,
          taxes_fees_cents: 5000,
        }),
      ],
    });
    const findings = await disproportionateTaxesFeesRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(
      findings
        .map((f) => f.affected_account_indexes)
        .flat()
        .sort(),
    ).toEqual([0, 1]);
  });
});
