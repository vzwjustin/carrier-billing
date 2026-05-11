import { describe, expect, it } from 'vitest';
import { unusedMifiLineRule } from '@/rules/definitions/unused-mifi-line';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('unused_mifi_or_jetpack_line rule', () => {
  it('fires when a Jetpack used effectively zero data', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              data_used_gb: 0.05,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low'); // M3: zero_use tier capped at 'low' pending activation_date_in_period schema
    expect(f.estimated_monthly_savings_cents).toBe(4000);
  });

  it('does not fire on a regular phone with low data', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPhone 15 Pro',
              data_used_gb: 0.05,
              plan_base_cents: 4500,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on a hotspot that is actually used', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Inseego 5G Hotspot',
              data_used_gb: 12.5,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires LOW severity (light_use tier) when hotspot used <1 GB but >=0.1 GB', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack',
              data_used_gb: 0.5,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.estimated_monthly_savings_cents).toBe(4000);
    const evidence = f.evidence as { tier: string };
    expect(evidence.tier).toBe('light_use');
  });

  it('fires LOW severity (zero_use tier) when hotspot used <0.1 GB (M3 cap)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack',
              data_used_gb: 0.05,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    // M3: zero_use tier severity capped at 'low' pending activation date
    // signal in the schema. Mid-cycle activations would otherwise produce
    // false-positive "suspend or cancel" findings on fresh devices.
    expect(f.severity).toBe('low');
    const evidence = f.evidence as { tier: string };
    expect(evidence.tier).toBe('zero_use');
  });

  it('does not fire when hotspot used exactly 1 GB (boundary)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Inseego 5G Hotspot',
              data_used_gb: 1.0,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when data_used_gb is null (missing data is not zero)', async () => {
    // Some carriers do not surface per-line usage on every bill. Treating
    // null as 0 would mis-flag every hotspot on those carriers.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              data_used_gb: null,
              plan_base_cents: 4000,
            }),
          ],
        }),
      ],
    });
    const findings = await unusedMifiLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
