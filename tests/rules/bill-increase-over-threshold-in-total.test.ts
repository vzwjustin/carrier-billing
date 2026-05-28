import { describe, expect, it } from 'vitest';
import { billIncreaseOverThresholdInTotalRule } from '@/rules/definitions/bill-increase-over-threshold-in-total';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('bill_increase_over_threshold_in_total rule', () => {
  it('fires when total is > 15% above component sum on a 3+ line bill', async () => {
    const c = ctx({
      total_charges_cents: 50000,
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 1000,
          lines: [
            makeLine({ plan_base_cents: 5000, features: [] }),
            makeLine({ plan_base_cents: 5000, features: [] }),
            makeLine({ plan_base_cents: 5000, features: [] }),
          ],
        }),
      ],
    });
    // component sum: 15000 + 1000 = 16000. 50000 / 16000 = 3.13×.
    const findings = await billIncreaseOverThresholdInTotalRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.5);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_line_indexes).toEqual([]);
    expect(f.affected_account_indexes).toEqual([]);
  });

  it('does not fire when total matches component sum within 15%', async () => {
    const c = ctx({
      total_charges_cents: 17000,
      accounts: [
        makeAccount({
          total_charges_cents: 17000,
          taxes_fees_cents: 2000,
          lines: [
            makeLine({ plan_base_cents: 5000, features: [] }),
            makeLine({ plan_base_cents: 5000, features: [] }),
            makeLine({ plan_base_cents: 5000, features: [] }),
          ],
        }),
      ],
    });
    // component sum: 15000 + 2000 = 17000. exact match.
    const findings = await billIncreaseOverThresholdInTotalRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on bills with fewer than 3 lines (peer floor)', async () => {
    const c = ctx({
      total_charges_cents: 100000,
      accounts: [
        makeAccount({
          total_charges_cents: 100000,
          taxes_fees_cents: 500,
          lines: [
            makeLine({ plan_base_cents: 5000, features: [] }),
            makeLine({ plan_base_cents: 5000, features: [] }),
          ],
        }),
      ],
    });
    const findings = await billIncreaseOverThresholdInTotalRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when total is BELOW component sum (different problem)', async () => {
    const c = ctx({
      total_charges_cents: 5000,
      accounts: [
        makeAccount({
          total_charges_cents: 5000,
          taxes_fees_cents: 5000,
          lines: [
            makeLine({ plan_base_cents: 10000 }),
            makeLine({ plan_base_cents: 10000 }),
            makeLine({ plan_base_cents: 10000 }),
          ],
        }),
      ],
    });
    const findings = await billIncreaseOverThresholdInTotalRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on very small bills (< $50 total)', async () => {
    const c = ctx({
      total_charges_cents: 1000,
      accounts: [
        makeAccount({
          total_charges_cents: 1000,
          taxes_fees_cents: 0,
          lines: [
            makeLine({ plan_base_cents: 100 }),
            makeLine({ plan_base_cents: 100 }),
            makeLine({ plan_base_cents: 100 }),
          ],
        }),
      ],
    });
    const findings = await billIncreaseOverThresholdInTotalRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
