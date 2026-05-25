import { describe, expect, it } from 'vitest';
import { featureFirstSeenRule } from '@/rules/definitions/feature-first-seen';
import type { RuleContext } from '@/rules/types';
import {
  makeAccount,
  makeBill,
  makeFeature,
  makeLine,
  TEST_TODAY,
} from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('feature_first_seen rule', () => {
  it('fires on a paid "premium" addon in the other category', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Premium Visual Voicemail',
                  category: 'other',
                  monthly_cents: 299,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.confidence).toBe(0.6);
    expect(f.estimated_monthly_savings_cents).toBe(299);
    expect(f.affected_line_indexes).toEqual([0]);
  });

  it('fires on +1 / rewards / boost / perks variants', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Verizon Plus 1', category: 'other', monthly_cents: 1000 }),
                makeFeature({ name: 'My Rewards', category: 'other', monthly_cents: 500 }),
                makeFeature({ name: 'Network Boost', category: 'other', monthly_cents: 700 }),
                makeFeature({ name: 'Perks Pack', category: 'other', monthly_cents: 300 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.estimated_monthly_savings_cents).toBe(2500);
  });

  it('does not fire on $0 features (skip free SOCs)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Premium Caller ID',
                  category: 'other',
                  monthly_cents: 0,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on insurance category (covered by orphan_insurance / insurance_after_device_payoff)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Premium Protection Plan',
                  category: 'insurance',
                  monthly_cents: 1700,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on international category (covered by stale_international_feature)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Premium International Calling',
                  category: 'international',
                  monthly_cents: 1500,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on cloud or hotspot category', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Cloud Premium',
                  category: 'cloud',
                  monthly_cents: 500,
                }),
                makeFeature({
                  name: 'Premium Hotspot',
                  category: 'hotspot',
                  monthly_cents: 1500,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on a generic non-marketing feature name (ambiguous — keep quiet)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Voicemail Transcription',
                  category: 'other',
                  monthly_cents: 199,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await featureFirstSeenRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
