import { describe, expect, it } from 'vitest';
import { duplicateProtectionFeaturesRule } from '@/rules/definitions/duplicate-protection-features';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('duplicate_protection_features rule', () => {
  it('fires when a line has two insurance features and saves total minus cheapest', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
                makeFeature({ name: 'AppleCare+', category: 'insurance', monthly_cents: 1099 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateProtectionFeaturesRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    // Total 2799, cheapest 1099 → savings 1700
    expect(f.estimated_monthly_savings_cents).toBe(1700);
    expect(f.confidence).toBe(0.9);
  });

  it('emits a single finding (not one per feature) and lists all names in evidence', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
                makeFeature({ name: 'AppleCare+', category: 'insurance', monthly_cents: 1099 }),
                makeFeature({ name: 'Asurion Premier', category: 'insurance', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateProtectionFeaturesRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const evidence = f.evidence as {
      feature_names: string[];
      count: number;
    };
    expect(evidence.count).toBe(3);
    expect(evidence.feature_names).toEqual([
      'Mobile Protect',
      'AppleCare+',
      'Asurion Premier',
    ]);
  });

  it('ignores non-insurance features when counting duplicates', async () => {
    // A line with one insurance + multiple non-insurance must NOT fire.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
                makeFeature({ name: 'Verizon Cloud', category: 'cloud', monthly_cents: 500 }),
                makeFeature({ name: 'TravelPass', category: 'international', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateProtectionFeaturesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when a line has only one insurance feature', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1700 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateProtectionFeaturesRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
