import { describe, expect, it } from 'vitest';
import { lineChargeOutlierWithinAccountRule } from '@/rules/definitions/line-charge-outlier-within-account';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('line_charge_outlier_within_account rule', () => {
  it('fires when one phone line is >= 2x peer median', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            // Peers: all at $40 each
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
            makeLine({ plan_base_cents: 4000, features: [] }),
            // Outlier: $100
            makeLine({
              plan_base_cents: 10000,
              features: [],
              device: 'iPhone 15 Pro',
            }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBe(0.65);
    expect(f.affected_line_indexes).toEqual([3]);
    expect(f.estimated_monthly_savings_cents).toBe(6000); // 10000 - 4000
  });

  it('considers features in the line cost', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 3000, features: [] }),
            makeLine({ plan_base_cents: 3000, features: [] }),
            makeLine({ plan_base_cents: 3000, features: [] }),
            makeLine({
              plan_base_cents: 3000,
              features: [makeFeature({ name: 'Loaded SOC stack', monthly_cents: 5000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.affected_line_indexes).toEqual([3]);
  });

  it('does not fire when there are fewer than 4 phone lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 12000 }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when the spread is within 2x', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 7000 }), // 1.75x median
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('excludes tablets/watches from peer set and candidacy', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4000, device: 'iPhone 15' }),
            makeLine({ plan_base_cents: 4000, device: 'iPhone 15' }),
            makeLine({ plan_base_cents: 4000, device: 'iPhone 15' }),
            makeLine({ plan_base_cents: 4000, device: 'iPhone 15' }),
            // Tablet @ $20 — should NOT pull median down or get flagged
            makeLine({ plan_base_cents: 2000, device: 'iPad Pro' }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('excludes suspended lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            // Suspended outlier — should not even be a candidate
            makeLine({ plan_base_cents: 20000, is_suspended: true }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('only fires once per account-level outlier (separate accounts each evaluated)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 4000 }),
            makeLine({ plan_base_cents: 9000 }),
          ],
        }),
        makeAccount({
          account_number_last4: '5555',
          lines: [
            makeLine({ plan_base_cents: 3000 }),
            makeLine({ plan_base_cents: 3000 }),
            makeLine({ plan_base_cents: 3000 }),
            makeLine({ plan_base_cents: 8000 }),
          ],
        }),
      ],
    });
    const findings = await lineChargeOutlierWithinAccountRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.affected_account_indexes[0]).sort()).toEqual([0, 1]);
  });
});
