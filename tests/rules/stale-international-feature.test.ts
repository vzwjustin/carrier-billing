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
    const evidence = f.evidence as { line_count: number; total_monthly_cents: number };
    expect(evidence.line_count).toBe(1);
    expect(evidence.total_monthly_cents).toBe(1000);
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

  it('rolls multiple international features on the same line into the single per-bill finding (L7)', async () => {
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
      per_line: { feature_names: string[]; total_cents: number }[];
      line_count: number;
      total_monthly_cents: number;
    };
    expect(evidence.line_count).toBe(1);
    expect(evidence.total_monthly_cents).toBe(5000);
    expect(evidence.per_line[0]?.feature_names).toEqual(['TravelPass', 'International Plan']);
  });

  it('rolls all lines into a single per-bill finding (L7)', async () => {
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
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as {
      line_count: number;
      total_monthly_cents: number;
      per_line: Array<{ account_index: number; line_index: number }>;
    };
    expect(evidence.line_count).toBe(2);
    expect(evidence.total_monthly_cents).toBe(8000);
    expect(evidence.per_line.map((p) => p.line_index)).toEqual([0, 1]);
  });
});
