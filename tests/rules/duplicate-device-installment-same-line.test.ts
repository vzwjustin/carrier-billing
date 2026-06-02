import { describe, expect, it } from 'vitest';
import { duplicateDeviceInstallmentSameLineRule } from '@/rules/definitions/duplicate-device-installment-same-line';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeDpp, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('duplicate_device_installment_same_line rule', () => {
  it('fires when one line has two DPPs for the same device', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ device: 'iPhone 15 Pro', monthly_cents: 3500 }),
                makeDpp({ device: 'iPhone 15 Pro', monthly_cents: 3500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.confidence).toBe(0.8);
    expect(f.estimated_monthly_savings_cents).toBe(3500); // one copy considered duplicate
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('keeps the cheapest installment when amounts differ (conservative)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ device: 'iPhone 15', monthly_cents: 3000 }),
                makeDpp({ device: 'iPhone 15', monthly_cents: 4500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_monthly_savings_cents).toBe(4500); // larger flagged as the duplicate
  });

  it('normalizes case and whitespace when matching device names', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ device: 'iPhone 15', monthly_cents: 2500 }),
                makeDpp({ device: 'IPHONE 15  ', monthly_cents: 2500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('does not fire when DPPs are for distinct devices', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ device: 'iPhone 15', monthly_cents: 3000 }),
                makeDpp({ device: 'AirPods Pro', monthly_cents: 1000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on lines with fewer than 2 DPPs', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [makeDpp({ device: 'iPhone 15' })],
            }),
            makeLine({ dpp_installments: [] }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires once per line, not per duplicate group', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              dpp_installments: [
                makeDpp({ device: 'iPhone 15', monthly_cents: 2000 }),
                makeDpp({ device: 'iPhone 15', monthly_cents: 2000 }),
                makeDpp({ device: 'AirPods', monthly_cents: 500 }),
                makeDpp({ device: 'AirPods', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateDeviceInstallmentSameLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_monthly_savings_cents).toBe(2500); // 2000 + 500
  });
});
