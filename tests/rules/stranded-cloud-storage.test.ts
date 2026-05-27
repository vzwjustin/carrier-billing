import { describe, expect, it, vi } from 'vitest';
import { strandedCloudStorageRule } from '@/rules/definitions/stranded-cloud-storage';
import type { RuleContext } from '@/rules/types';
import {
  makeAccount,
  makeBill,
  makeDpp,
  makeFeature,
  makeLine,
  TEST_TODAY,
} from './fixtures';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('stranded_cloud_storage rule', () => {
  it('fires medium severity when cloud feature is billed on a suspended line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              features: [
                makeFeature({ name: 'Verizon Cloud', category: 'cloud', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('medium');
    expect(f.estimated_monthly_savings_cents).toBe(500);
    expect(f.confidence).toBe(0.75);
    expect(f.evidence?.is_suspended).toBe(true);
    expect(f.evidence?.no_device_no_dpp).toBe(false);
  });

  it('fires low severity when cloud is billed on a line with no device + no DPP', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: false,
              device: null,
              features: [
                makeFeature({ name: 'AT&T Photo Storage', category: 'cloud', monthly_cents: 300 }),
              ],
              dpp_installments: [],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.evidence?.no_device_no_dpp).toBe(true);
  });

  it('sums multiple cloud features into a single finding', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              features: [
                makeFeature({ name: 'Cloud Basic', category: 'cloud', monthly_cents: 300 }),
                makeFeature({ name: 'Cloud Plus', category: 'cloud', monthly_cents: 700 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.estimated_monthly_savings_cents).toBe(1000);
  });

  it('does NOT fire when the line has a device and is not suspended (BYOD users may legitimately use cloud)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: false,
              device: 'iPhone 15',
              features: [
                makeFeature({ name: 'Verizon Cloud', category: 'cloud', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the line has no device but still has an active DPP', async () => {
    // device=null + DPP present means a device exists in billing but wasn't
    // extracted by name — still considered active, don't fire.
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: false,
              device: null,
              features: [
                makeFeature({ name: 'Verizon Cloud', category: 'cloud', monthly_cents: 500 }),
              ],
              dpp_installments: [
                makeDpp({ total_payments: 24, remaining_payments: 12 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the line has no cloud feature', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              is_suspended: true,
              features: [
                makeFeature({ name: 'Mobile Protect', category: 'insurance', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await strandedCloudStorageRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
