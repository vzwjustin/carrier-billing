import { describe, expect, it } from 'vitest';
import { dppExceedsPlanBaseRule } from '@/rules/definitions/dpp-exceeds-plan-base';
import type { RuleContext } from '@/rules/types';
import {
  makeAccount,
  makeBill,
  makeDpp,
  makeLine,
  TEST_TODAY,
} from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('dpp_exceeds_plan_base rule', () => {
  it('fires when DPP monthly exceeds plan base', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 3500,
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 15 Pro Max',
                  monthly_cents: 5500,
                  remaining_payments: 24,
                  total_payments: 36,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.confidence).toBe(0.7);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.evidence).toMatchObject({
      plan_base_cents: 3500,
      dpp_total_cents: 5500,
    });
  });

  it('sums multiple active DPPs on the same line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4000,
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 15 Pro',
                  monthly_cents: 3000,
                  remaining_payments: 18,
                }),
                makeDpp({
                  device: 'Apple Watch',
                  monthly_cents: 1500,
                  remaining_payments: 12,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    // 3000+1500=4500 > 4000 → fires
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.evidence.dpp_total_cents).toBe(4500);
  });

  it('does not fire when DPP equals plan base (boundary, must strictly exceed)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4500,
              dpp_installments: [
                makeDpp({ monthly_cents: 4500, remaining_payments: 12 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when DPP is less than plan base', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4500,
              dpp_installments: [
                makeDpp({ monthly_cents: 2799, remaining_payments: 12 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when there are no DPPs', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ plan_base_cents: 4500, dpp_installments: [] }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when DPP remaining_payments is 0 (covered by completed_device_payment)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 3500,
              dpp_installments: [
                makeDpp({ monthly_cents: 5500, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_base_cents is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: null,
              dpp_installments: [
                makeDpp({ monthly_cents: 5500, remaining_payments: 24 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_base_cents is 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 0,
              dpp_installments: [
                makeDpp({ monthly_cents: 5500, remaining_payments: 24 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when DPP monthly is 0 (ambiguous DPP row)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 100,
              dpp_installments: [
                makeDpp({ monthly_cents: 0, remaining_payments: 5 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await dppExceedsPlanBaseRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
