import { describe, expect, it } from 'vitest';
import { staleInternationalFeatureRule } from '@/rules/definitions/stale-international-feature';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('stale_international_feature rule', () => {
  it('fires info severity when an international feature is present', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'TravelPass',
                  category: 'international',
                  monthly_cents: 1000,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await staleInternationalFeatureRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.confidence).toBe(0.6);
  });

  it('does not fire when no international feature is present', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'Mobile Protect',
                  category: 'insurance',
                  monthly_cents: 1700,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await staleInternationalFeatureRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('aggregates multiple international features on the same line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({
                  name: 'TravelPass',
                  category: 'international',
                  monthly_cents: 1000,
                }),
                makeFeature({
                  name: 'International Plan',
                  category: 'international',
                  monthly_cents: 4000,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await staleInternationalFeatureRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as {
      international_features: { name: string; monthly_cents: number }[];
    };
    expect(evidence.international_features).toHaveLength(2);
    expect(f.description).toContain('TravelPass');
    expect(f.description).toContain('International Plan');
  });

  it('emits one finding per line with international features', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              features: [
                makeFeature({
                  name: 'TravelPass',
                  category: 'international',
                  monthly_cents: 1000,
                }),
              ],
            }),
            makeLine({
              mdn_last4: '2222',
              features: [
                makeFeature({
                  name: 'Global Plus',
                  category: 'international',
                  monthly_cents: 7000,
                }),
              ],
            }),
            makeLine({
              mdn_last4: '3333',
              features: [],
            }),
          ],
        }),
      ],
    });
    const findings = await staleInternationalFeatureRule.evaluate(c);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.affected_line_indexes).toEqual([0]);
    expect(findings[1]?.affected_line_indexes).toEqual([1]);
  });
});
