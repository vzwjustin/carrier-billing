import { describe, expect, it } from 'vitest';
import { dataOveragePatternRule } from '@/rules/definitions/data-overage-pattern';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('data_overage_pattern rule', () => {
  it('fires (very_high_any_plan) when usage exceeds 100 GB regardless of plan', async () => {
    // Use a non-top-tier plan to prove the >100GB branch fires regardless.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Start 2.0',
              data_used_gb: 150,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.estimated_monthly_savings_cents).toBe(0);
    const evidence = f.evidence as { branch: string; threshold_gb: number };
    expect(evidence.branch).toBe('very_high_any_plan');
    expect(evidence.threshold_gb).toBe(100);
  });

  it('fires (heavy_top_tier) when usage >50 GB on a top-tier plan but ≤100 GB', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              data_used_gb: 75,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as { branch: string };
    expect(evidence.branch).toBe('heavy_top_tier');
  });

  it('does not fire when usage >50 GB on a non-top-tier plan (and ≤100 GB)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Start 2.0',
              data_used_gb: 80,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on light usage', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              data_used_gb: 5,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not double-fire: a >100GB line emits one (very_high) finding only', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              data_used_gb: 200,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as { branch: string };
    expect(evidence.branch).toBe('very_high_any_plan');
  });
});
