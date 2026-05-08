import { describe, expect, it } from 'vitest';
import { suspendedLineBilledRule } from '@/rules/definitions/suspended-line-billed';
import type { RuleContext } from '@/rules/types';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(over: Parameters<typeof makeBill>[0] = {}): RuleContext {
  const bill = makeBill(over);
  return { bill, today: TEST_TODAY, carrier: bill.carrier };
}

describe('suspended_line_billed rule', () => {
  it('fires high severity when suspended line is still billed', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [makeLine({ is_suspended: true, plan_base_cents: 4500 })],
        }),
      ],
    });
    const findings = await suspendedLineBilledRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.estimated_monthly_savings_cents).toBe(4500);
  });

  it('does not fire on suspended line with zero plan charge', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [makeLine({ is_suspended: true, plan_base_cents: 0 })],
        }),
      ],
    });
    const findings = await suspendedLineBilledRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  it('does not fire on active line', async () => {
    const c = ctx({
      accounts: [
        makeAccount({
          lines: [makeLine({ is_suspended: false, plan_base_cents: 4500 })],
        }),
      ],
    });
    const findings = await suspendedLineBilledRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });
});
