import { describe, expect, it } from 'vitest';
import { zeroUsagePhoneLineRule } from '@/rules/definitions/zero-usage-phone-line';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('zero_usage_phone_line rule', () => {
  it('fires when phone line has zero voice, sms, and data', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPhone 15',
              plan_base_cents: 4500,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(4500);
    expect(f.confidence).toBe(0.85);
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('does not fire when any usage signal is null (unknown != zero)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              data_used_gb: 0,
              voice_used_min: null,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when any usage signal is > 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 1,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on suspended lines (covered by suspended_line_billed)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on hotspot devices (covered by unused_mifi_or_jetpack_line)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_base_cents is 0 (free spare line)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 0,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('fires once per matching line across multiple accounts', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 3500,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
            makeLine({
              plan_base_cents: 4500,
              data_used_gb: 1,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
        makeAccount({
          account_number_last4: '1111',
          lines: [
            makeLine({
              plan_base_cents: 5500,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await zeroUsagePhoneLineRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.estimated_monthly_savings_cents).sort()).toEqual([3500, 5500]);
  });
});
