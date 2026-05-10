import { describe, expect, it, vi } from 'vitest';
import { expiredPromoCreditRule } from '@/rules/definitions/expired-promo-credit';
import { accountPromoExpiringSoonRule } from '@/rules/definitions/account-promo-expiring-soon';
import { runRules } from '@/rules/runner';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeCredit, makeLine, TEST_TODAY } from './fixtures';

// Stub Sentry so the runner doesn't try to ship anything during tests.
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

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

  it('fires medium severity (expiring-soon branch) when credit expires exactly today', async () => {
    // TEST_TODAY = 2026-05-08. `isExpired` is strict-past (< 0 days), so a
    // credit expiring today is NOT expired yet — it falls under the
    // "expiring within 30 days" branch (severity: medium, confidence: 0.95).
    const c = ctx({
      accounts: [
        makeAccount({
          account_level_credits: [
            makeCredit({
              name: 'Expires-today credit',
              monthly_cents: -2000,
              expires_on: '2026-05-08',
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
    expect(f.confidence).toBe(0.95);
    expect(f.estimated_monthly_savings_cents).toBe(2000);
  });
});

describe('expired_promo_credit + account_promo_expiring_soon — no double-fire', () => {
  // Window placement matrix (TEST_TODAY = 2026-05-08):
  //   already expired  →  only expired_promo_credit
  //   expires today    →  only expired_promo_credit (within-30 branch)
  //   expires day 30   →  only expired_promo_credit (within-30 branch)
  //   expires day 31   →  only account_promo_expiring_soon (31..60 window)
  //   expires day 60   →  only account_promo_expiring_soon (31..60 window)
  //   expires day 61   →  neither
  // The two rules MUST NOT both fire on the same credit at any window slot.
  const cases: Array<{ label: string; expires_on: string; expectRules: string[] }> = [
    { label: 'already-expired', expires_on: '2026-04-01', expectRules: ['expired_promo_credit'] },
    { label: 'expires-today', expires_on: '2026-05-08', expectRules: ['expired_promo_credit'] },
    { label: 'expires-day-30', expires_on: '2026-06-07', expectRules: ['expired_promo_credit'] },
    { label: 'expires-day-31', expires_on: '2026-06-08', expectRules: ['account_level_promo_about_to_expire'] },
    { label: 'expires-day-60', expires_on: '2026-07-07', expectRules: ['account_level_promo_about_to_expire'] },
    { label: 'expires-day-61', expires_on: '2026-07-08', expectRules: [] },
  ];

  it.each(cases)(
    'fires exactly the expected rule(s) for $label ($expires_on)',
    async ({ expires_on, expectRules }) => {
      const bill = makeBill({
        accounts: [
          makeAccount({
            account_level_credits: [
              makeCredit({
                name: `Credit ${expires_on}`,
                monthly_cents: -1500,
                expires_on,
              }),
            ],
            // No lines that would trigger other rules — keep the bill quiet
            // so we can isolate just the credit-related findings.
            lines: [makeLine()],
          }),
        ],
      });
      const ruleCtx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
      const result = await runRules(ruleCtx, [
        expiredPromoCreditRule,
        accountPromoExpiringSoonRule,
      ]);
      const firedRuleIds = result.findings.map((f) => f.rule_id).sort();
      expect(firedRuleIds).toEqual([...expectRules].sort());
      // Belt-and-suspenders: the two credit rules must never both fire on
      // the same credit, regardless of window position.
      const credit = firedRuleIds.filter((id) =>
        id === 'expired_promo_credit' || id === 'account_level_promo_about_to_expire',
      );
      expect(credit.length).toBeLessThanOrEqual(1);
    },
  );
});
