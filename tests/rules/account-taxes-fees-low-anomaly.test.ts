import { describe, expect, it } from 'vitest';
import { accountTaxesFeesLowAnomalyRule } from '@/rules/definitions/account-taxes-fees-low-anomaly';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('account_taxes_fees_low_anomaly rule', () => {
  it('fires when taxes_fees ratio is below 4% (likely parser miss)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 100000, // $1000
          taxes_fees_cents: 2000, // 2%
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.5);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.affected_line_indexes).toEqual([]);
    expect(f.evidence).toMatchObject({
      taxes_fees_cents: 2000,
      total_charges_cents: 100000,
      ratio: 0.02,
    });
  });

  it('fires when ratio is 0 (extractor saw fees section but it summed to zero)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 0,
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('does not fire at the 4% boundary (must be strictly under)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 100000,
          taxes_fees_cents: 4000, // exactly 4%
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on a typical (10%+) ratio', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 5000, // 10%
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when taxes_fees_cents is null (separate signal — out of scope)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: null,
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on tiny totals (< $10) — noise floor (ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 500, // $5
          taxes_fees_cents: 5,
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires independently on each account in a multi-account bill', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          total_charges_cents: 100000,
          taxes_fees_cents: 1000, // 1%
          lines: [makeLine()],
        }),
        makeAccount({
          account_number_last4: '2222',
          total_charges_cents: 100000,
          taxes_fees_cents: 15000, // 15% — typical, no finding
          lines: [makeLine()],
        }),
      ],
    });
    const findings = await accountTaxesFeesLowAnomalyRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.affected_account_indexes).toEqual([0]);
  });
});
