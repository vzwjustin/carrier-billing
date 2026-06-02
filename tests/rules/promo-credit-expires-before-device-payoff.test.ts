import { describe, expect, it } from 'vitest';
import { promoCreditExpiresBeforeDevicePayoffRule } from '@/rules/definitions/promo-credit-expires-before-device-payoff';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeCredit, makeDpp, makeLine, TEST_TODAY } from './fixtures';

// TEST_TODAY is 2026-05-08. A credit expiring 2026-08-31 is ~3 calendar
// months out; one expiring 2027-05-31 is ~12 months out.
function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('promo_credit_expires_before_device_payoff rule', () => {
  it('fires when a promo credit expires well before the device payoff', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [makeCredit({ monthly_cents: -2500, expires_on: '2026-08-31' })],
              dpp_installments: [makeDpp({ remaining_payments: 24, total_payments: 36 })],
            }),
          ],
        }),
      ],
    });
    // credit ~3 months out, device 24 payments left → gap ~21 months.
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.confidence).toBe(0.6);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.evidence.future_monthly_increase_cents).toBe(2500);
    expect(f.evidence.credit_expires_in_months).toBe(3);
    expect(f.evidence.dpp_months_remaining).toBe(24);
  });

  it('sums multiple qualifying credits into the future increase', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [
                makeCredit({ monthly_cents: -2000, expires_on: '2026-08-31' }),
                makeCredit({ monthly_cents: -1000, expires_on: '2026-07-31' }),
              ],
              dpp_installments: [makeDpp({ remaining_payments: 20 })],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(1);
    // Soonest expiry drives the headline month count (2026-07-31 ≈ 2 months).
    expect(findings[0]?.evidence.future_monthly_increase_cents).toBe(3000);
    expect(findings[0]?.evidence.credit_expires_in_months).toBe(2);
  });

  it('does not fire when the credit outlasts the device payoff', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [makeCredit({ monthly_cents: -2500, expires_on: '2027-05-31' })],
              dpp_installments: [makeDpp({ remaining_payments: 3 })],
            }),
          ],
        }),
      ],
    });
    // credit ~12 months out, device only 3 payments left → no gap.
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when the gap is within the noise threshold (< 2 months)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              // ~3 months to expiry, 4 payments left → gap of 1 month.
              credits: [makeCredit({ monthly_cents: -2500, expires_on: '2026-08-31' })],
              dpp_installments: [makeDpp({ remaining_payments: 4 })],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('ignores credits with no printed expiry', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [makeCredit({ monthly_cents: -2500, expires_on: null })],
              dpp_installments: [makeDpp({ remaining_payments: 24 })],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('ignores non-promotional credits (e.g. permanent loyalty discounts)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [
                makeCredit({
                  monthly_cents: -2500,
                  expires_on: '2026-08-31',
                  is_promo: false,
                }),
              ],
              dpp_installments: [makeDpp({ remaining_payments: 24 })],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('skips DPPs with no printed remaining-payment count', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [makeCredit({ monthly_cents: -2500, expires_on: '2026-08-31' })],
              dpp_installments: [makeDpp({ remaining_payments: null, total_payments: null })],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on a line with no device payment plan', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [makeCredit({ monthly_cents: -2500, expires_on: '2026-08-31' })],
              dpp_installments: [],
            }),
          ],
        }),
      ],
    });
    const findings = await promoCreditExpiresBeforeDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
