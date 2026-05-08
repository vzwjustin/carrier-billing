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
    expect(f.severity).toBe('medium');
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
});
