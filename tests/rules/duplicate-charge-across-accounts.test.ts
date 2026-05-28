import { describe, expect, it } from 'vitest';
import { duplicateChargeAcrossAccountsRule } from '@/rules/definitions/duplicate-charge-across-accounts';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeFeature, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('duplicate_charge_across_accounts rule wrapper', () => {
  it('exposes the expected rule id + applies to all carriers', () => {
    expect(duplicateChargeAcrossAccountsRule.id).toBe(
      'duplicate_charge_across_accounts',
    );
    expect(duplicateChargeAcrossAccountsRule.appliesTo).toBe('all');
  });

  it('fires (medium) when two BANs carry an identically-named + priced feature', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'TravelPass Daily', monthly_cents: 1000 }),
              ],
            }),
          ],
        }),
        makeAccount({
          account_number_last4: '2222',
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'TravelPass Daily', monthly_cents: 1000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateChargeAcrossAccountsRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.rule_id).toBe('duplicate_charge_across_accounts');
    expect(f.severity).toBe('medium');
    expect(f.affected_account_indexes.sort()).toEqual([0, 1]);
    // Cross-account findings leave line indexes empty — see detector
    // comments for the translateLineIndexes interaction.
    expect(f.affected_line_indexes).toEqual([]);
  });

  it('does NOT fire when the duplicate is confined to a single account', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Hotspot', monthly_cents: 1500 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Hotspot', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = await duplicateChargeAcrossAccountsRule.evaluate(c);
    expect(findings).toEqual([]);
  });

  it('does NOT fire on a single-account bill with no duplicates', async () => {
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
    const findings = await duplicateChargeAcrossAccountsRule.evaluate(c);
    expect(findings).toEqual([]);
  });
});
