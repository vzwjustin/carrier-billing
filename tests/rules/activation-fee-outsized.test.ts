import { describe, expect, it } from 'vitest';
import { activationFeeOutsizedRule } from '@/rules/definitions/activation-fee-outsized';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('activation_fee_outsized rule', () => {
  it('fires on an activation fee > $35', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 4500 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBe(0.85);
    expect(f.estimated_monthly_savings_cents).toBe(0); // one-time, not monthly
    expect(f.evidence.one_time_savings_cents).toBe(4500);
    expect(f.recommended_action).toMatch(/waive|credit/i);
  });

  it('fires on an upgrade fee > $35', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Device Upgrade Fee',
                  monthly_cents: 5500,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('does not fire when activation fee is exactly at the ceiling', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 3500 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when activation fee is under $35', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 2000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on non-activation features even if expensive', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'International Roaming Add-on',
                  monthly_cents: 9000,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('sums multiple outsized activation rows on the same line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Activation Fee', monthly_cents: 4000 }),
                makeFeature({
                  name: 'Upgrade Activation Fee',
                  monthly_cents: 4500,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOutsizedRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.one_time_savings_cents).toBe(8500);
  });
});
