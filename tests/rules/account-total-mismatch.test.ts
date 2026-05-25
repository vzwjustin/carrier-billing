import { describe, expect, it } from 'vitest';
import { accountTotalMismatchRule } from '@/rules/definitions/account-total-mismatch';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('account_total_mismatch rule', () => {
  it('fires when total exceeds component sum by > $1 and > 1%', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 2000,
          lines: [
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
          ],
        }),
      ],
    });
    // component sum: 12000 + 2000 = 14000. total 50000. diff 36000. ratio 0.72.
    const findings = await accountTotalMismatchRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.6);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_account_indexes).toEqual([0]);
  });

  it('does not fire when difference is within 1% AND under $1 (no gate)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 14050,
          taxes_fees_cents: 2000,
          lines: [
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
          ],
        }),
      ],
    });
    // component sum: 14000. total 14050. diff 50 cents (< 100 absolute threshold).
    const findings = await accountTotalMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when difference is > $1 but well under 1% of total', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 1000000, // $10,000
          taxes_fees_cents: 0,
          lines: Array.from({ length: 100 }).map(() =>
            makeLine({ plan_base_cents: 9990, features: [] }),
          ),
        }),
      ],
    });
    // component sum: 999000. total 1000000. diff 1000. ratio 0.001 < 0.01.
    const findings = await accountTotalMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on accounts with fewer than 3 lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          total_charges_cents: 50000,
          taxes_fees_cents: 0,
          lines: [
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
          ],
        }),
      ],
    });
    const findings = await accountTotalMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires when component sum exceeds the printed total too (under-billing pattern)', async () => {
    const c = ctx({
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
    // component sum: 35000. total 5000. diff 30000. direction = under.
    const findings = await accountTotalMismatchRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.direction).toBe('under');
  });
});
