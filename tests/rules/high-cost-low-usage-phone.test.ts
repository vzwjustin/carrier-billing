import { describe, expect, it } from 'vitest';
import { highCostLowUsagePhoneRule } from '@/rules/definitions/high-cost-low-usage-phone';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('high_cost_low_usage_phone rule', () => {
  it('fires when ≥$75 plan with all 3 usage dims below threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 8000,
              data_used_gb: 1,
              voice_used_min: 10,
              sms_used_count: 5,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.confidence).toBe(0.7);
    expect(f.estimated_monthly_savings_cents).toBe(2000);
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('does not fire when plan_base is below $75', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 7000,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when data usage is at or above threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 8000,
              data_used_gb: 2,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when voice usage is at or above threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 8000,
              data_used_gb: 0,
              voice_used_min: 30,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when SMS usage is at or above threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 8000,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 30,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when any usage signal is null (ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 8000,
              data_used_gb: null,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on suspended lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              plan_base_cents: 8000,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on hotspot devices', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              plan_base_cents: 8000,
              data_used_gb: 1,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await highCostLowUsagePhoneRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
