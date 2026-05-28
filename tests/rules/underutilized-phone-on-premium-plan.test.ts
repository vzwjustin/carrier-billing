import { describe, expect, it, vi } from 'vitest';
import { underutilizedPhoneOnPremiumPlanRule } from '@/rules/definitions/underutilized-phone-on-premium-plan';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('underutilized_phone_on_premium_plan rule', () => {
  it('fires when a premium-tier plan is paired with low data + low voice', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Pro 2.0',
              plan_base_cents: 6500,
              data_used_gb: 1.2,
              voice_used_min: 15,
              is_suspended: false,
              device: 'iPhone 15',
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.estimated_monthly_savings_cents).toBe(1000);
    expect(f.confidence).toBe(0.55);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.evidence?.plan_name).toBe('Business Unlimited Pro 2.0');
    expect(f.evidence?.data_used_gb).toBe(1.2);
    expect(f.evidence?.voice_used_min).toBe(15);
  });

  it('matches all premium-tier name variants (pro/premium/plus/advanced/ultimate/elite)', async () => {
    const variants = [
      'Unlimited Pro',
      'Unlimited Premium',
      'Unlimited Plus',
      'Advanced 2.0',
      'Ultimate Business',
      'Elite Unlimited',
    ];
    for (const planName of variants) {
      const c = ctx({
        accounts: [
          makeAccount({
            lines: [
              makeLine({
                plan_name: planName,
                data_used_gb: 1,
                voice_used_min: 15,
              }),
            ],
          }),
        ],
      });
      const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
      expect(findings, `expected fire for "${planName}"`).toHaveLength(1);
    }
  });

  it('does NOT fire when the plan is not premium-tier', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Start',
              data_used_gb: 1,
              voice_used_min: 5,
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when data usage reaches the LOW_DATA_GB threshold (5GB)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: 5,
              voice_used_min: 10,
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when voice usage reaches the LOW_VOICE_MIN threshold (60)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: 1,
              voice_used_min: 60,
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the line is suspended (suspended_line_billed handles that case)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: 1,
              voice_used_min: 5,
              is_suspended: true,
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire on hotspot/MiFi/Jetpack devices (unused_mifi_or_jetpack_line handles those)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: 1,
              voice_used_min: 5,
              device: 'Jetpack MiFi 8800L',
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when plan_name is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: null,
              data_used_gb: 1,
              voice_used_min: 5,
            }),
          ],
        }),
      ],
    });
    const findings = await underutilizedPhoneOnPremiumPlanRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when usage signals are null (carrier did not report)', async () => {
    // Both null
    const c1 = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: null,
              voice_used_min: null,
            }),
          ],
        }),
      ],
    });
    expect(await underutilizedPhoneOnPremiumPlanRule.evaluate(c1)).toHaveLength(0);

    // Only data null
    const c2 = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: null,
              voice_used_min: 5,
            }),
          ],
        }),
      ],
    });
    expect(await underutilizedPhoneOnPremiumPlanRule.evaluate(c2)).toHaveLength(0);

    // Only voice null
    const c3 = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Unlimited Pro',
              data_used_gb: 1,
              voice_used_min: null,
            }),
          ],
        }),
      ],
    });
    expect(await underutilizedPhoneOnPremiumPlanRule.evaluate(c3)).toHaveLength(0);
  });
});
