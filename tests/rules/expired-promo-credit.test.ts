import { describe, expect, it } from 'vitest';
import { expiredPromoCreditRule } from '@/rules/definitions/expired-promo-credit';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeCredit, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('expired_promo_credit rule', () => {
  it('fires high severity when account credit is expired', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({ name: 'Loyalty', monthly_cents: -2500, expires_on: '2026-04-01' }),
          ],
        }),
      ],
    });
    const findings = await expiredPromoCreditRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.estimated_monthly_savings_cents).toBe(2500);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.affected_line_indexes).toEqual([]);
    // Already-expired credits get 0.98 confidence (vs 0.95 for expiring-soon).
    expect(f.confidence).toBe(0.98);
  });

  it('uses lower confidence (0.95) for credits expiring within 30 days', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({ name: 'Soon', monthly_cents: -1000, expires_on: '2026-05-25' }),
          ],
        }),
      ],
    });
    const findings = await expiredPromoCreditRule.evaluate(c);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.confidence).toBe(0.95);
  });

  it('fires medium severity when line credit expires within 30 days', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              credits: [
                makeCredit({ name: 'Promo', monthly_cents: -1500, expires_on: '2026-05-25' }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await expiredPromoCreditRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(1500);
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('does not fire for credits expiring far in the future', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({ name: 'Long Promo', monthly_cents: -1000, expires_on: '2027-01-01' }),
          ],
        }),
      ],
    });
    const findings = await expiredPromoCreditRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire for credits with null expiration', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({ name: 'Indefinite', monthly_cents: -500, expires_on: null }),
          ],
        }),
      ],
    });
    const findings = await expiredPromoCreditRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
