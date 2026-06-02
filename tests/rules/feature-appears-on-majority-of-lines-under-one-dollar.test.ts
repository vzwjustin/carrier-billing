import { describe, expect, it } from 'vitest';
import { featureAppearsOnMajorityOfLinesUnderOneDollarRule } from '@/rules/definitions/feature-appears-on-majority-of-lines-under-one-dollar';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('feature_appears_on_majority_of_lines_under_one_dollar rule', () => {
  it('fires when a sub-$1 feature is on 100% of 5 lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: Array.from({ length: 5 }).map(() =>
            makeLine({
              features: [
                makeFeature({
                  name: 'Regulatory Recovery Surcharge',
                  monthly_cents: 1,
                }),
              ],
            }),
          ),
        }),
      ],
    });
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.5);
    expect(f.estimated_monthly_savings_cents).toBe(5);
    expect(f.affected_line_indexes).toEqual([0, 1, 2, 3, 4]);
  });

  it('fires when fan-out is exactly at the 80% threshold', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            ...Array.from({ length: 4 }).map(() =>
              makeLine({
                features: [makeFeature({ name: 'Tiny Fee', monthly_cents: 25 })],
              }),
            ),
            makeLine({ features: [] }),
          ],
        }),
      ],
    });
    // 4 of 5 = 80% (≥ ceil(5*0.8)=4)
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });

  it('does not fire when fan-out is below 80%', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            ...Array.from({ length: 3 }).map(() =>
              makeLine({
                features: [makeFeature({ name: 'Tiny Fee', monthly_cents: 25 })],
              }),
            ),
            ...Array.from({ length: 2 }).map(() => makeLine({ features: [] })),
          ],
        }),
      ],
    });
    // 3 of 5 = 60% < 80%
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when any occurrence is at or above $1', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Fee', monthly_cents: 1 })],
            }),
            makeLine({
              features: [makeFeature({ name: 'Fee', monthly_cents: 1 })],
            }),
            makeLine({
              features: [makeFeature({ name: 'Fee', monthly_cents: 100 })],
            }),
          ],
        }),
      ],
    });
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when account has fewer than 3 lines', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Tiny', monthly_cents: 1 })],
            }),
            makeLine({
              features: [makeFeature({ name: 'Tiny', monthly_cents: 1 })],
            }),
          ],
        }),
      ],
    });
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on all-zero rows (recurring saving is zero)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: Array.from({ length: 5 }).map(() =>
            makeLine({
              features: [makeFeature({ name: 'Documentation Row', monthly_cents: 0 })],
            }),
          ),
        }),
      ],
    });
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('groups features case-insensitively', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: Array.from({ length: 4 }).map((_, i) =>
            makeLine({
              features: [
                makeFeature({
                  name: i % 2 === 0 ? 'Carrier Fee' : 'CARRIER FEE',
                  monthly_cents: 5,
                }),
              ],
            }),
          ),
        }),
      ],
    });
    const findings = await featureAppearsOnMajorityOfLinesUnderOneDollarRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.occurrences).toBe(4);
  });
});
