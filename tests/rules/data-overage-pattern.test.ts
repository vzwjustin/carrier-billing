import { describe, expect, it } from 'vitest';
import { dataOveragePatternRule } from '@/rules/definitions/data-overage-pattern';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('data_overage_pattern rule', () => {
  it('fires (approaching_soft_cap) at 85% of known plan cap (Verizon Pro 2.0, 200 GB)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              data_used_gb: 170,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    const evidence = f.evidence as {
      branch: string;
      threshold_gb: number;
      utilization_ratio: number;
    };
    expect(evidence.branch).toBe('approaching_soft_cap');
    expect(evidence.threshold_gb).toBe(200);
    expect(evidence.utilization_ratio).toBe(0.85);
  });

  it('fires (over_soft_cap) when usage exceeds known plan cap (AT&T Starter, 22 GB)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Starter',
              data_used_gb: 30,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as { branch: string; threshold_gb: number };
    expect(evidence.branch).toBe('over_soft_cap');
    expect(evidence.threshold_gb).toBe(22);
  });

  it('does not fire when usage is below 80% of known cap (AT&T Starter at 50%)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Starter',
              data_used_gb: 11,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('falls back to very_high_any_plan branch for unknown plans at >100 GB', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Custom Legacy Unlimited Plan',
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
    const evidence = f.evidence as { branch: string; threshold_gb: number };
    expect(evidence.branch).toBe('very_high_any_plan');
    expect(evidence.threshold_gb).toBe(100);
  });

  it('does not fire on unknown plans below the 50 GB generic threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Custom Legacy Unlimited Plan',
              data_used_gb: 30,
            }),
          ],
        }),
      ],
    });
    const findings = await dataOveragePatternRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on light usage (any plan)', async () => {
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

  it('emits one finding per qualifying line; soft-cap branch is authoritative for known plans', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              data_used_gb: 250, // over soft cap (200) AND > 100 GB absolute
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
    expect(evidence.branch).toBe('over_soft_cap');
  });
});
