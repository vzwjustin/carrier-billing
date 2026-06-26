import { describe, expect, it } from 'vitest';
import { unassignedUserLabelRule } from '@/rules/definitions/unassigned-user-label';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('unassigned_user_label rule', () => {
  it('fires on a single unlabeled line in a mostly-labeled fleet', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'Sales A', device: 'iPhone 15' }),
            makeLine({ user_label: 'Sales B', device: 'iPhone 15' }),
            makeLine({ user_label: 'Sales C', device: 'iPhone 15' }),
            // The unlabeled outlier
            makeLine({ user_label: null, device: 'iPhone 15' }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe(0.7);
    expect(f.estimated_monthly_savings_cents).toBe(0);
    expect(f.affected_line_indexes).toEqual([3]);
  });

  it('does not fire on an account with no labeled lines (labeling not in use)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: null, device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15' }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when only one peer has a label (below MIN_LABELED_PEERS)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'Only One Labeled', device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15' }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on hotspot devices (legitimately no owner)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'A', device: 'iPhone 15' }),
            makeLine({ user_label: 'B', device: 'iPhone 15' }),
            makeLine({
              user_label: null,
              device: 'Verizon Jetpack MiFi 8800L',
            }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on routers/IoT gateways (legitimately no human owner)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'A', device: 'iPhone 15' }),
            makeLine({ user_label: 'B', device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'Cradlepoint IBR900 Router' }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when device is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'A', device: 'iPhone 15' }),
            makeLine({ user_label: 'B', device: 'iPhone 15' }),
            makeLine({ user_label: null, device: null }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire when plan_name is null', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'A', device: 'iPhone 15' }),
            makeLine({ user_label: 'B', device: 'iPhone 15' }),
            makeLine({ user_label: null, device: 'iPhone 15', plan_name: null }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('treats whitespace-only user_label as unlabeled', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({ user_label: 'A', device: 'iPhone 15' }),
            makeLine({ user_label: 'B', device: 'iPhone 15' }),
            makeLine({ user_label: 'C', device: 'iPhone 15' }),
            makeLine({ user_label: '   ', device: 'iPhone 15' }),
          ],
        }),
      ],
    });
    const findings = await unassignedUserLabelRule.evaluate(c);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.affected_line_indexes).toEqual([3]);
  });
});
