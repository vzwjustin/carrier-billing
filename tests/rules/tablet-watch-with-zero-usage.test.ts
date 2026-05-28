import { describe, expect, it } from 'vitest';
import { tabletWatchWithZeroUsageRule } from '@/rules/definitions/tablet-watch-with-zero-usage';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('tablet_watch_with_zero_usage rule', () => {
  it('fires when an iPad line has zero data and voice', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad Pro 12.9',
              plan_base_cents: 2000,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBe(0.85);
    expect(f.estimated_monthly_savings_cents).toBe(2000);
    expect(f.recommended_action).toMatch(/shared|NumberShare|NumberSync|DIGITS/i);
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('fires for an Apple Watch line with zero usage', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Apple Watch Series 9',
              plan_base_cents: 1000,
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('fires for a Gizmo (kids watch) line with zero usage', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Gizmo Watch 3',
              plan_base_cents: 1000,
              data_used_gb: 0,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('does not fire for a phone (covered by zero_usage_phone_line)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPhone 15',
              data_used_gb: 0,
              voice_used_min: 0,
              sms_used_count: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire for a hotspot device (covered by unused_mifi_or_jetpack_line)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              data_used_gb: 0,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when data usage is > 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad Air',
              data_used_gb: 0.5,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when voice usage is > 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Apple Watch Ultra',
              data_used_gb: 0,
              voice_used_min: 5,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when data_used_gb is null (unknown != zero, ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad',
              data_used_gb: null,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when voice_used_min is null (ambiguous)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad',
              data_used_gb: 0,
              voice_used_min: null,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when device is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: null,
              data_used_gb: 0,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when line is suspended', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad Pro',
              is_suspended: true,
              data_used_gb: 0,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_base_cents is 0', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'iPad',
              plan_base_cents: 0,
              data_used_gb: 0,
              voice_used_min: 0,
            }),
          ],
        }),
      ],
    });
    const findings = await tabletWatchWithZeroUsageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
