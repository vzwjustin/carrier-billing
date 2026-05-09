/**
 * Unknown-carrier end-to-end rules-runner test.
 *
 * Asserts that a bill whose detected carrier is `'unknown'` (e.g. detect.ts
 * couldn't classify the header) still runs successfully through the rules
 * runner with carrier-agnostic rules firing and carrier-specific rules
 * skipping. We do NOT touch real fixtures or the LLM here — the bill is
 * synthesized in-memory.
 *
 * Pipeline modeled:
 *   detectCarrier (mocked) → 'unknown'
 *   extractBill   (mocked) → synthesized ExtractedBill with carrier='unknown'
 *   runRules      (real)   → executes 'all'-applicable rules, skips
 *                            ['verizon'|'att'|'tmobile']-only rules
 *
 * Final state asserted: rules complete, findings list contains only output
 * from carrier-agnostic rules, and the per-rule runner errors list is empty
 * (an unknown carrier should not crash any rule — it's a normal control flow
 * branch in `ruleApplies`).
 */
import { describe, expect, it, vi } from 'vitest';

import type { Rule, RuleContext } from '@/rules/types';
import { runRules } from '@/rules/runner';
import type { ExtractedBill } from '@/extraction/schema';

// ---------------------------------------------------------------------------
// Mocks: detect + LLM. Our test never imports them on a live path, but
// `detect` and `llm` are listed in the task spec so we install the mocks to
// document the dependency boundary and ensure no accidental network calls.
// ---------------------------------------------------------------------------

vi.mock('@/extraction/detect', () => ({
  detectCarrier: () => 'unknown',
}));

vi.mock('@/extraction/llm', () => ({
  extractBill: async (): Promise<ExtractedBill> => unknownCarrierBill(),
  ExtractionError: class extends Error {},
}));

// Sentry stub — runner traps per-rule throws and reports them; we just want
// the test to be quiet.
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// In-memory bill fixture with carrier='unknown'.
// ---------------------------------------------------------------------------

function unknownCarrierBill(): ExtractedBill {
  return {
    carrier: 'unknown',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 50000,
    accounts: [
      {
        account_number_last4: '1234',
        label: 'Main',
        total_charges_cents: 50000,
        taxes_fees_cents: 5000,
        account_level_credits: [
          {
            name: 'Loyalty Credit',
            monthly_cents: -2500,
            // Already expired — would trigger the `expired_promo_credit` rule
            // (which is `appliesTo: 'all'`).
            expires_on: '2026-04-01',
            is_promo: true,
          },
        ],
        lines: [
          {
            mdn_last4: '1111',
            user_label: null,
            device: 'iPhone 14',
            plan_name: 'Generic Unlimited',
            plan_base_cents: 4500,
            data_used_gb: 5.5,
            voice_used_min: 0,
            sms_used_count: 0,
            is_suspended: true, // would trigger `suspended_line_billed`
            features: [],
            credits: [],
            dpp_installments: [],
          },
        ],
      },
    ],
    notes: ['Test bill: unknown carrier'],
  };
}

// ---------------------------------------------------------------------------
// Rule fixtures: one carrier-agnostic, three carrier-specific. We can't
// modify the production registry, but the runner accepts an explicit `rules`
// arg so we feed it our test set.
// ---------------------------------------------------------------------------

let agnosticEvalCount = 0;
const agnosticRule: Rule = {
  id: 'agnostic_test_rule',
  title: 'Always runs (test fixture)',
  appliesTo: 'all',
  evaluate: () => {
    agnosticEvalCount += 1;
    return [
      {
        rule_id: 'agnostic_test_rule',
        severity: 'low',
        title: 'Test finding',
        description: 'Unknown carrier should still run agnostic rules.',
        recommended_action: 'No action — test scaffolding only.',
        estimated_monthly_savings_cents: 0,
        confidence: 1,
        affected_line_indexes: [],
        affected_account_indexes: [0],
        evidence: { source: 'test' },
      },
    ];
  },
};

const verizonOnlyRule: Rule = {
  id: 'verizon_only_test_rule',
  title: 'Verizon-only (test fixture)',
  appliesTo: ['verizon'],
  evaluate: () => {
    throw new Error('verizon-only rule should not have been evaluated');
  },
};

const attOnlyRule: Rule = {
  id: 'att_only_test_rule',
  title: 'AT&T-only (test fixture)',
  appliesTo: ['att'],
  evaluate: () => {
    throw new Error('att-only rule should not have been evaluated');
  },
};

const tmobileOnlyRule: Rule = {
  id: 'tmobile_only_test_rule',
  title: 'T-Mobile-only (test fixture)',
  appliesTo: ['tmobile'],
  evaluate: () => {
    throw new Error('tmobile-only rule should not have been evaluated');
  },
};

describe('Unknown carrier — end-to-end rules runner', () => {
  it('skips carrier-specific rules and runs agnostic rules to completion', async () => {
    agnosticEvalCount = 0;

    const bill = unknownCarrierBill();
    const ctx: RuleContext = {
      bill,
      today: new Date('2026-05-08T12:00:00Z'),
      carrier: bill.carrier,
    };

    const result = await runRules(ctx, [
      agnosticRule,
      verizonOnlyRule,
      attOnlyRule,
      tmobileOnlyRule,
    ]);

    // The agnostic rule fired exactly once; carrier-specific rules were
    // never evaluated (their evaluate() would have thrown).
    expect(agnosticEvalCount).toBe(1);
    expect(result.errors).toEqual([]);

    // Findings include only agnostic output — fewer findings than a
    // detected-carrier bill would produce.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule_id).toBe('agnostic_test_rule');
  });

  it('still produces 0 findings + 0 errors when only carrier-specific rules apply', async () => {
    // The "audit reaches completed with possibly fewer findings" contract:
    // even if every rule we register is carrier-specific (and the carrier is
    // unknown), the runner returns an empty result rather than crashing.
    const bill = unknownCarrierBill();
    const ctx: RuleContext = {
      bill,
      today: new Date('2026-05-08T12:00:00Z'),
      carrier: bill.carrier,
    };

    const result = await runRules(ctx, [
      verizonOnlyRule,
      attOnlyRule,
      tmobileOnlyRule,
    ]);

    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('exercises the production rule registry against an unknown-carrier bill without throwing', async () => {
    // All rules in `ALL_RULES` are currently `appliesTo: 'all'` (verified by
    // grep against src/rules/definitions). For unknown carriers they all
    // run. We assert the runner returns cleanly — no per-rule error, no
    // exception escaped — which proves the audit can transition to
    // 'completed' even when carrier detection fails.
    const { ALL_RULES } = await import('@/rules/registry');

    const bill = unknownCarrierBill();
    const ctx: RuleContext = {
      bill,
      today: new Date('2026-05-08T12:00:00Z'),
      carrier: bill.carrier,
    };

    const result = await runRules(ctx, ALL_RULES);

    expect(result.errors).toEqual([]);
    // Findings shape is sane (every entry has a rule_id + severity).
    for (const f of result.findings) {
      expect(typeof f.rule_id).toBe('string');
      expect(['high', 'medium', 'low', 'info']).toContain(f.severity);
    }
  });
});
