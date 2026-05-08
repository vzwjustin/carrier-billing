import { describe, expect, it } from 'vitest';
import { orphanInsuranceRule } from '@/rules/definitions/orphan-insurance';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('orphan_insurance rule', () => {
  it('fires high severity when line is suspended with insurance', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await orphanInsuranceRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.estimated_monthly_savings_cents).toBe(1700);
  });

  it('fires medium severity when no device is on file', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: null,
              dpp_installments: [],
              features: [
                makeFeature({ name: 'Total Mobile Protection', category: 'insurance', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await orphanInsuranceRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(1500);
  });

  it('does not fire when there is an active device', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPhone 15',
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await orphanInsuranceRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
