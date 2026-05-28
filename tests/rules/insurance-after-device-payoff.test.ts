import { describe, expect, it, vi } from 'vitest';
import { insuranceAfterDevicePayoffRule } from '@/rules/definitions/insurance-after-device-payoff';
import type { RuleContext } from '@/rules/types';
import {
  makeAccount,
  makeBill,
  makeDpp,
  makeFeature,
  makeLine,
  TEST_TODAY,
} from './fixtures';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('insurance_after_device_payoff rule', () => {
  it('fires when an unsuspended line has insurance and at least one paid-off DPP', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: false,
              features: [
                makeFeature({
                  name: 'Mobile Protect Plan',
                  category: 'insurance',
                  monthly_cents: 1500,
                }),
              ],
              dpp_installments: [
                makeDpp({ total_payments: 36, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(1500);
    expect(f.confidence).toBe(0.85);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.evidence?.paid_off_dpp_count).toBe(1);
  });

  it('sums multiple insurance features into one finding', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
                makeFeature({ name: 'Asurion Extended', category: 'insurance', monthly_cents: 700 }),
              ],
              dpp_installments: [
                makeDpp({ total_payments: 36, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_monthly_savings_cents).toBe(2200);
  });

  it('does NOT fire when the line is suspended (orphan_insurance handles that case)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
              ],
              dpp_installments: [
                makeDpp({ total_payments: 36, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when no DPP is paid off (still actively paying for the device)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
              ],
              dpp_installments: [
                makeDpp({ total_payments: 36, remaining_payments: 12 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the line has no insurance feature', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Hotspot 50GB', category: 'hotspot' })],
              dpp_installments: [
                makeDpp({ total_payments: 36, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when there are no DPP installments at all (no payoff signal)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
              ],
              dpp_installments: [],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires once even when multiple DPPs are paid off', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
              ],
              dpp_installments: [
                makeDpp({ device: 'iPhone 13', total_payments: 36, remaining_payments: 0 }),
                makeDpp({ device: 'Apple Watch', total_payments: 24, remaining_payments: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await insuranceAfterDevicePayoffRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence?.paid_off_dpp_count).toBe(2);
  });
});
