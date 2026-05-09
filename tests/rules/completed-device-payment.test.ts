import { describe, expect, it } from 'vitest';
import { completedDevicePaymentRule } from '@/rules/definitions/completed-device-payment';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeDpp, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('completed_device_payment_still_billed rule', () => {
  it('fires when remaining_payments is 0 but monthly_cents is positive', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 13',
                  monthly_cents: 2799,
                  remaining_payments: 0,
                  total_payments: 36,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.estimated_monthly_savings_cents).toBe(2799);
    expect(f.evidence).toMatchObject({ device: 'iPhone 13', remaining_payments: 0 });
  });

  it('does not fire when payments remain', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ remaining_payments: 12, total_payments: 36, monthly_cents: 3333 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when remaining is 0 but monthly is also 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ remaining_payments: 0, total_payments: 36, monthly_cents: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when both remaining and total are null (insufficient data)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 12',
                  monthly_cents: 2500,
                  remaining_payments: null,
                  total_payments: null,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires when remaining_payments is 0 regardless of total_payments value', async () => {
    // total_payments is captured for evidence only; the rule trusts
    // remaining_payments directly.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 12 Pro',
                  monthly_cents: 3499,
                  remaining_payments: 0,
                  total_payments: 24,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.estimated_monthly_savings_cents).toBe(3499);
    expect(f.evidence).toMatchObject({
      remaining_payments: 0,
      total_payments: 24,
    });
  });

  it('does not fire when remaining_payments is null even if total_payments is present', async () => {
    // Without an explicit remaining count we have no positive signal that
    // the plan is complete — the rule should stay silent.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 13',
                  monthly_cents: 2799,
                  remaining_payments: null,
                  total_payments: 36,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await completedDevicePaymentRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
