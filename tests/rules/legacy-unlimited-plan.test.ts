import { describe, expect, it } from 'vitest';
import { legacyUnlimitedPlanRule } from '@/rules/definitions/legacy-unlimited-plan';
import type { RuleContext } from '@/rules/types';
import type { Carrier } from '@/extraction/schema';
import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

function ctx(carrier: Carrier, planName: string): RuleContext {
  const bill = makeBill({
    carrier,
    accounts: [
      makeAccount({
        lines: [makeLine({ plan_name: planName })],
      }),
    ],
  });
  return { bill, today: TEST_TODAY, carrier };
}

describe('legacy_unlimited_plan rule — Verizon patterns', () => {
  it.each([
    ['More Everything 10GB'],
    ['Verizon Plan Unlimited'],
    ['Nationwide 450'],
    ['Single Line Plan'],
  ])('flags Verizon legacy plan: %s', async (plan) => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('verizon', plan));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('low');
    expect(f.confidence).toBe(0.75);
    expect(f.estimated_monthly_savings_cents).toBeGreaterThanOrEqual(500);
    expect(f.estimated_monthly_savings_cents).toBeLessThanOrEqual(1500);
    expect(f.evidence).toMatchObject({
      plan_name: plan,
      carrier: 'verizon',
      replacement_plan: expect.stringMatching(/Business Unlimited/i),
    });
  });

  it.each([
    ['Business Unlimited Pro 2.0'],
    ['Business Unlimited Plus 2.0'],
    ['Verizon Plan Unlimited Pro'],
    ['Verizon Plan Unlimited Plus'],
    ['Verizon Plan Unlimited Start'],
  ])('does NOT flag current Verizon plan: %s', async (plan) => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('verizon', plan));
    expect(findings).toHaveLength(0);
  });
});

describe('legacy_unlimited_plan rule — AT&T patterns', () => {
  it.each([
    ['Mobile Share 5GB'],
    ['AT&T Mobile Share'],
    ['Family Talk 1400'],
    ['Nation 900'],
    ['Unlimited Plus'],
  ])('flags AT&T legacy plan: %s', async (plan) => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('att', plan));
    expect(findings).toHaveLength(1);
  });

  it.each([
    ['Business Unlimited Premium'],
    ['Mobile Share Plus'],
    ['Mobile Share Premium'],
    ['Unlimited Plus for iPhone'],
  ])('does NOT flag current AT&T plan: %s', async (plan) => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('att', plan));
    expect(findings).toHaveLength(0);
  });
});

describe('legacy_unlimited_plan rule — T-Mobile patterns', () => {
  it.each([['Simple Choice Unlimited'], ['Magenta'], ['T-Mobile ONE']])(
    'flags T-Mobile legacy plan: %s',
    async (plan) => {
      const findings = await legacyUnlimitedPlanRule.evaluate(ctx('tmobile', plan));
      expect(findings).toHaveLength(1);
    },
  );

  it.each([
    ['Magenta Plus'],
    ['Magenta Max'],
    ['Magenta Business'],
    ['Magenta 55+'],
    ['Magenta Military'],
    ['Magenta First Responder'],
    ['T-Mobile ONE Business'],
    ['Business Unlimited Ultimate'],
    // Carrier-bill abbreviations + tablet variants. T-Mobile bills print
    // "Bus" as the abbreviation for "Business" and "Tab" for tablet-line
    // SKUs. Both are currently-sold plans and must NOT be flagged as legacy.
    ['Magenta Bus'],
    ['Magenta Bus Tab 10GB Promo'],
    ['Magenta Tab'],
    ['Magenta Tablet 10GB'],
    ['Magenta Business Tab'],
  ])('does NOT flag current T-Mobile plan: %s', async (plan) => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('tmobile', plan));
    expect(findings).toHaveLength(0);
  });
});

describe('legacy_unlimited_plan rule — anchored regex (no false-positives on future SKUs)', () => {
  it('does NOT flag a hypothetical future "Verizon Plan Unlimited Edge" SKU', async () => {
    // Anchor + whitelist guards prevent the prefix match from catching new
    // SKUs that share the "Verizon Plan Unlimited" stem.
    const findings = await legacyUnlimitedPlanRule.evaluate(
      ctx('verizon', 'Verizon Plan Unlimited Edge'),
    );
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag "Magenta Plus" via the bare Magenta pattern', async () => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('tmobile', 'Magenta Plus'));
    expect(findings).toHaveLength(0);
  });
});

describe('legacy_unlimited_plan rule — unknown carrier', () => {
  it('runs the union of all patterns when carrier is unknown', async () => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('unknown', 'Magenta'));
    expect(findings).toHaveLength(1);
  });

  it('does not fire on a current plan even when carrier is unknown', async () => {
    const findings = await legacyUnlimitedPlanRule.evaluate(
      ctx('unknown', 'Business Unlimited Pro 2.0'),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('legacy_unlimited_plan rule — replacement plan + savings', () => {
  it('recommends Business Unlimited Performance for AT&T Mobile Share', async () => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('att', 'Mobile Share 5GB'));
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.evidence).toMatchObject({
      replacement_plan: 'Business Unlimited Performance',
      carrier: 'att',
    });
    expect(f.estimated_monthly_savings_cents).toBe(1000);
  });

  it('recommends Business Unlimited Advanced for T-Mobile ONE', async () => {
    const findings = await legacyUnlimitedPlanRule.evaluate(ctx('tmobile', 'T-Mobile ONE'));
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.evidence).toMatchObject({
      replacement_plan: 'Business Unlimited Advanced',
      carrier: 'tmobile',
    });
    expect(f.estimated_monthly_savings_cents).toBe(700);
  });

  it('all carrier-specific savings stay within the $5–$15/mo conservative band', async () => {
    const cases: Array<[Carrier, string]> = [
      ['verizon', 'More Everything 10GB'],
      ['verizon', 'Nationwide 450'],
      ['att', 'Family Talk 1400'],
      ['att', 'Unlimited Plus'],
      ['tmobile', 'Simple Choice Unlimited'],
      ['tmobile', 'Magenta'],
    ];
    for (const [c, plan] of cases) {
      const findings = await legacyUnlimitedPlanRule.evaluate(ctx(c, plan));
      const f = findings[0];
      if (!f) throw new Error(`expected finding for ${c}/${plan}`);
      expect(f.estimated_monthly_savings_cents).toBeGreaterThanOrEqual(500);
      expect(f.estimated_monthly_savings_cents).toBeLessThanOrEqual(1500);
    }
  });
});

describe('legacy_unlimited_plan rule — null plan_name', () => {
  it('skips lines with no plan name', async () => {
    const bill = makeBill({
      carrier: 'verizon',
      accounts: [makeAccount({ lines: [makeLine({ plan_name: null })] })],
    });
    const findings = await legacyUnlimitedPlanRule.evaluate({
      bill,
      today: TEST_TODAY,
      carrier: 'verizon',
    });
    expect(findings).toHaveLength(0);
  });
});
