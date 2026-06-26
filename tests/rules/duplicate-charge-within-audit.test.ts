import { describe, expect, it } from 'vitest';
import { duplicateChargeWithinAuditRule } from '@/rules/definitions/duplicate-charge-within-audit';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('duplicate_charge_within_audit rule wrapper', () => {
  it('exposes the expected rule id + applies to all carriers', () => {
    expect(duplicateChargeWithinAuditRule.id).toBe('duplicate_charge_within_audit');
    expect(duplicateChargeWithinAuditRule.appliesTo).toBe('all');
  });

  it('fires when two lines in the SAME account carry an identical feature', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Mobile Hotspot', monthly_cents: 1500 })],
            }),
            makeLine({
              features: [makeFeature({ name: 'Mobile Hotspot', monthly_cents: 1500 })],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateChargeWithinAuditRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.rule_id).toBe('duplicate_charge_within_audit');
    expect(f.severity).toBe('high');
    expect(f.affected_account_indexes).toEqual([0]);
  });

  it('does NOT fire when the duplicate spans two accounts (that is the across-accounts rule)', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          lines: [
            makeLine({
              features: [makeFeature({ name: 'International Pack', monthly_cents: 2000 })],
            }),
          ],
        }),
        makeAccount({
          account_number_last4: '2222',
          lines: [
            makeLine({
              features: [makeFeature({ name: 'International Pack', monthly_cents: 2000 })],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateChargeWithinAuditRule.evaluate(c);
    expect(findings).toEqual([]);
  });

  it('does NOT fire on a bill with no duplicates', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Solo Feature', monthly_cents: 999 })],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateChargeWithinAuditRule.evaluate(c);
    expect(findings).toEqual([]);
  });
});
