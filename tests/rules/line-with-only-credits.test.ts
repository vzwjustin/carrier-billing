import { describe, expect, it } from 'vitest';
import { lineWithOnlyCreditsRule } from '@/rules/definitions/line-with-only-credits';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeCredit, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('line_with_only_credits rule', () => {
  it('fires when credits fully offset the plan base (net zero)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4500,
              features: [],
              credits: [makeCredit({ monthly_cents: -4500 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.7);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.evidence).toMatchObject({
      plan_base_cents: 4500,
      credits_total_cents: -4500,
      net_cents: 0,
    });
  });

  it('fires when credits exceed plan + features (net negative)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 3000,
              features: [makeFeature({ name: 'Extra', category: 'other', monthly_cents: 500 })],
              credits: [makeCredit({ monthly_cents: -5000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.evidence.net_cents).toBe(-1500);
  });

  it('does not fire when net is positive (line is profitable to the carrier)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4500,
              features: [],
              credits: [makeCredit({ monthly_cents: -1000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when there are no credits at all', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 0, // even with $0 plan
              features: [],
              credits: [],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on suspended lines (covered by suspended_line_billed)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              plan_base_cents: 4500,
              credits: [makeCredit({ monthly_cents: -4500 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on a trivially-zero line ($0 plan + $0 credit — ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 0,
              features: [],
              credits: [makeCredit({ monthly_cents: 0 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_base_cents is null and no other charges (ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: null,
              features: [],
              credits: [makeCredit({ monthly_cents: 0 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires on multiple matching lines across accounts', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          lines: [
            makeLine({
              plan_base_cents: 3000,
              credits: [makeCredit({ monthly_cents: -3500 })],
            }),
            makeLine({
              plan_base_cents: 4500,
              credits: [makeCredit({ monthly_cents: -1000 })],
            }), // net +3500, no finding
          ],
        }),
        makeAccount({
          account_number_last4: '2222',
          lines: [
            makeLine({
              plan_base_cents: 2000,
              credits: [makeCredit({ monthly_cents: -2000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await lineWithOnlyCreditsRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.affected_account_indexes[0]).sort()).toEqual([0, 1]);
  });
});
