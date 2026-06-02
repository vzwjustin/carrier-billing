import { describe, expect, it, vi } from 'vitest';
import { activationFeeOnExistingLineRule } from '@/rules/definitions/activation-fee-on-existing-line';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeDpp, makeFeature, makeLine, TEST_TODAY } from './fixtures';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('activation_fee_on_existing_line rule', () => {
  it('fires when activation fee is billed on a line with established DPP history', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 3500 })],
              dpp_installments: [makeDpp({ total_payments: 36, remaining_payments: 12 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    // One-time fee: must NOT contribute to monthly rollup (annualized 12x by mark-completed).
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.evidence?.one_time_savings_cents).toBe(3500);
    expect(f.evidence?.total_fee_cents).toBe(3500);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.confidence).toBe(0.7);
  });

  it('also matches "Connection Fee", "SIM Setup Fee", and "Upgrade Fee" variants', async () => {
    const variants = ['Connection Fee', 'SIM Setup Fee', 'Upgrade Fee'];
    for (const name of variants) {
      const c = ctx({
        accounts: [
          makeAccount({
            lines: [
              makeLine({
                features: [makeFeature({ name, monthly_cents: 2000 })],
                dpp_installments: [makeDpp({ total_payments: 24, remaining_payments: 6 })],
              }),
            ],
          }),
        ],
      });
      const findings = await activationFeeOnExistingLineRule.evaluate(c);
      expect(findings, `expected match for "${name}"`).toHaveLength(1);
    }
  });

  it('sums multiple activation-shaped fees on the same line into one finding', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Activation Fee', monthly_cents: 3500 }),
                makeFeature({ name: 'Connection Fee', monthly_cents: 1000 }),
              ],
              dpp_installments: [makeDpp({ total_payments: 24, remaining_payments: 6 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence?.total_fee_cents).toBe(4500);
    expect(findings[0]?.evidence?.one_time_savings_cents).toBe(4500);
  });

  it('does NOT fire when the line has no DPP history (could be a genuinely new line)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 3500 })],
              dpp_installments: [],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the DPP has zero payments posted (still genuinely new)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 3500 })],
              // remaining === total means no payments have been posted yet.
              dpp_installments: [makeDpp({ total_payments: 36, remaining_payments: 36 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when DPP fields are null (carrier did not report installment metadata)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Activation Fee', monthly_cents: 3500 })],
              dpp_installments: [makeDpp({ total_payments: null, remaining_payments: null })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when no activation-shaped feature is present', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Mobile Protect', monthly_cents: 1500 })],
              dpp_installments: [makeDpp({ total_payments: 24, remaining_payments: 6 })],
            }),
          ],
        }),
      ],
    });
    const findings = await activationFeeOnExistingLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
