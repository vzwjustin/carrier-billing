import { describe, expect, it } from 'vitest';
import { redundantHotspotAddonRule } from '@/rules/definitions/redundant-hotspot-addon';
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

describe('redundant_hotspot_addon rule', () => {
  it('fires when premium plan has paid mobile hotspot add-on', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Plus 2.0',
              features: [
                makeFeature({ name: 'Mobile Hotspot 30GB', monthly_cents: 2000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(2000);
    expect(f.confidence).toBe(0.75);
  });

  it('sums multiple paid hotspot add-ons on the same line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Performance',
              features: [
                makeFeature({ name: 'Mobile Hotspot', monthly_cents: 1500 }),
                makeFeature({ name: 'Tethering Add-on', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.estimated_monthly_savings_cents).toBe(2000);
  });

  it('does not fire on $0 hotspot rows (carrier documents included allotment)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Premium',
              features: [
                makeFeature({ name: 'Mobile Hotspot 100GB', monthly_cents: 0 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on starter/base-tier plans (no included hotspot)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Start 2.0',
              features: [
                makeFeature({ name: 'Mobile Hotspot 15GB', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on hotspot devices themselves (Jetpack/MiFi lines)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              device: 'Verizon Jetpack MiFi 8800L',
              plan_name: 'Business Unlimited Plus',
              features: [
                makeFeature({ name: 'Mobile Hotspot', monthly_cents: 2000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_name is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: null,
              features: [
                makeFeature({ name: 'Mobile Hotspot', monthly_cents: 2000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('ignores international hotspot features (different product)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_name: 'Business Unlimited Plus',
              features: [
                makeFeature({
                  name: 'International Mobile Hotspot',
                  monthly_cents: 2500,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await redundantHotspotAddonRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
