import { describe, expect, it } from 'vitest';
import { accountPromoExpiringSoonRule } from '@/rules/definitions/account-promo-expiring-soon';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeCredit, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('account_level_promo_about_to_expire rule', () => {
  it('does not fire when account credit expires within 30 days (covered by expired_promo_credit)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Loyalty Discount',
              monthly_cents: -2500,
              expires_on: '2026-05-15', // 7 days from TEST_TODAY (2026-05-08)
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires medium severity when account credit expires in 31-60 days', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'New Customer Promo',
              monthly_cents: -3000,
              expires_on: '2026-06-15', // 38 days from TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(3000);
  });

  it('does not fire at the 30-day boundary (handled by expired_promo_credit)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Boundary Credit',
              monthly_cents: -1000,
              expires_on: '2026-06-07', // exactly 30 days from TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it("fires at the 31-day boundary (start of this rule's window)", async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Start of window',
              monthly_cents: -1000,
              expires_on: '2026-06-08', // exactly 31 days from TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    const evidence = f.evidence as { days_until_expiry: number };
    expect(evidence.days_until_expiry).toBe(31);
  });

  it("FIRES at exactly day 60 (end of this rule's window, inclusive)", async () => {
    // TEST_TODAY = 2026-05-08; day 60 = 2026-07-07.
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Day-60 boundary credit',
              monthly_cents: -2200,
              expires_on: '2026-07-07',
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    const evidence = f.evidence as { days_until_expiry: number };
    expect(evidence.days_until_expiry).toBe(60);
  });

  it("does NOT fire at exactly day 61 (one day past the rule's window)", async () => {
    // TEST_TODAY = 2026-05-08; day 61 = 2026-07-08.
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Day-61 boundary credit',
              monthly_cents: -2200,
              expires_on: '2026-07-08',
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when account credit expires more than 60 days out', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Long Promo',
              monthly_cents: -2000,
              expires_on: '2026-09-01', // ~116 days from TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when account credit has no expiry date', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Permanent Discount',
              monthly_cents: -1500,
              expires_on: null,
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when account credit is already expired (handled by expired_promo_credit)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Expired Promo',
              monthly_cents: -1000,
              expires_on: '2026-04-01', // before TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('uses absolute value of credit amount for savings (handles signed cents)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Signed Negative',
              monthly_cents: -4200,
              expires_on: '2026-06-20', // 43 days from TEST_TODAY
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.estimated_monthly_savings_cents).toBe(4200);
    expect(f.severity).toBe('medium');
  });

  it('emits one finding per qualifying credit across multiple accounts', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          label: 'Account A',
          // 0..30-day credits are NOT this rule's responsibility anymore.
          account_level_credits: [
            makeCredit({
              name: 'Credit A (in window)',
              monthly_cents: -1000,
              expires_on: '2026-06-15', // 38 days
            }),
          ],
        }),
        makeAccount({
          label: 'Account B',
          account_level_credits: [
            makeCredit({
              name: 'Credit B (in window)',
              monthly_cents: -2000,
              expires_on: '2026-07-01', // 54 days
            }),
            makeCredit({
              name: 'Credit B-2 (no expiry)',
              monthly_cents: -500,
              expires_on: null,
            }),
            makeCredit({
              name: 'Credit B-3 (under 30 days, other rule)',
              monthly_cents: -300,
              expires_on: '2026-05-20', // 12 days — handled by expired_promo_credit
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.affected_account_indexes).toEqual([0]);
    expect(findings[1]?.affected_account_indexes).toEqual([1]);
    findings.forEach((f) => expect(f.severity).toBe('medium'));
  });

  it('records days_until_expiry in evidence', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Tracked Credit',
              monthly_cents: -2000,
              expires_on: '2026-06-22', // 45 days
            }),
          ],
        }),
      ],
    });
    const findings = await accountPromoExpiringSoonRule.evaluate(c);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as {
      credit_name: string;
      expires_on: string;
      days_until_expiry: number;
      monthly_cents: number;
    };
    expect(evidence.credit_name).toBe('Tracked Credit');
    expect(evidence.expires_on).toBe('2026-06-22');
    expect(evidence.days_until_expiry).toBe(45);
    expect(evidence.monthly_cents).toBe(-2000);
  });
});
