import { describe, expect, it, vi } from 'vitest';

import type { ContractWithTerms } from '@/contracts/schema';
import { contractRateMismatchRule } from '@/rules/definitions/contract-rate-mismatch';
import type { RuleContext } from '@/rules/types';

import { makeAccount, makeBill, makeLine, TEST_TODAY } from './fixtures';

// Stub Sentry so any throw path stays quiet.
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

function ctx(args: {
  carrier?: 'verizon' | 'att' | 'tmobile' | 'unknown';
  lines?: ReturnType<typeof makeLine>[];
  contracts?: ContractWithTerms[];
}): RuleContext {
  const bill = makeBill({
    carrier: args.carrier ?? 'verizon',
    accounts: [makeAccount({ lines: args.lines ?? [makeLine()] })],
  });
  return {
    bill,
    today: TEST_TODAY,
    carrier: bill.carrier,
    contracts: args.contracts,
  };
}

function makeContract(over: Partial<ContractWithTerms> = {}): ContractWithTerms {
  return {
    id: 'contract-1',
    carrier: 'verizon',
    ban_last4: '0000',
    effective_date: '2026-01-01',
    expiration_date: '2028-12-31',
    terms: {
      plan_name: 'Business Unlimited Pro 2.0',
      contracted_monthly_rate_cents: 4000,
      discount_percentage_bps: null,
      waived_fees: null,
      promo_credit_cents: null,
      promo_duration_months: null,
      device_credit_terms: null,
      line_minimums: null,
      upgrade_fee_rules: null,
      activation_fee_rules: null,
      international_package_terms: null,
      early_termination_terms: null,
      notes: null,
    },
    ...over,
  };
}

describe('contract_rate_mismatch rule', () => {
  // ── Positive ───────────────────────────────────────────────────────────
  it('fires high severity when the billed plan_base exceeds the contracted rate by >10%', async () => {
    // Contract: $40/mo. Bill: $50/mo → 25% over → fires.
    const c = ctx({
      lines: [makeLine({ plan_name: 'Business Unlimited Pro 2.0', plan_base_cents: 5000 })],
      contracts: [makeContract()],
    });

    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.severity).toBe('high');
    expect(f.confidence).toBe(0.9);
    expect(f.estimated_monthly_savings_cents).toBe(1000);
    expect(f.affected_line_indexes).toEqual([0]);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.evidence.contract_id).toBe('contract-1');
    expect(f.evidence.contracted_monthly_rate_cents).toBe(4000);
    expect(f.evidence.billed_plan_base_cents).toBe(5000);
  });

  // ── Negative #1: no contracts loaded ──────────────────────────────────
  it('does NOT fire when ctx.contracts is undefined (rule remains a no-op)', async () => {
    const c = ctx({
      lines: [makeLine({ plan_name: 'Business Unlimited Pro 2.0', plan_base_cents: 5000 })],
      contracts: undefined,
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  // ── Negative #2: overage below threshold ──────────────────────────────
  it('does NOT fire when the overage is under the 10% threshold', async () => {
    // Contract: $40/mo. Bill: $43/mo → 7.5% over → below threshold.
    const c = ctx({
      lines: [makeLine({ plan_name: 'Business Unlimited Pro 2.0', plan_base_cents: 4300 })],
      contracts: [makeContract()],
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  // ── Negative #3: plan name mismatch ───────────────────────────────────
  it('does NOT fire when the line plan_name does not match any contracted plan', async () => {
    const c = ctx({
      lines: [
        makeLine({
          plan_name: 'Business Unlimited Plus 2.0',
          plan_base_cents: 5000,
        }),
      ],
      contracts: [makeContract()],
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  // ── Negative #4: carrier mismatch ─────────────────────────────────────
  it('does NOT fire when the contract is for a different carrier than the bill', async () => {
    const c = ctx({
      carrier: 'att',
      lines: [makeLine({ plan_name: 'Business Unlimited Pro 2.0', plan_base_cents: 5000 })],
      contracts: [makeContract({ carrier: 'verizon' })],
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  // ── Negative #5: contract with null terms or null rate ────────────────
  it('does NOT fire when the contract has no terms row or no contracted rate', async () => {
    const c = ctx({
      lines: [makeLine({ plan_name: 'Business Unlimited Pro 2.0', plan_base_cents: 5000 })],
      contracts: [
        makeContract({ terms: null }),
        makeContract({
          id: 'contract-2',
          terms: {
            plan_name: 'Business Unlimited Pro 2.0',
            contracted_monthly_rate_cents: null,
            discount_percentage_bps: null,
            waived_fees: null,
            promo_credit_cents: null,
            promo_duration_months: null,
            device_credit_terms: null,
            line_minimums: null,
            upgrade_fee_rules: null,
            activation_fee_rules: null,
            international_package_terms: null,
            early_termination_terms: null,
            notes: null,
          },
        }),
      ],
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(0);
  });

  // ── Edge: plan-name normalization (case + whitespace) ─────────────────
  it('matches plan names case-insensitively with collapsed whitespace', async () => {
    const c = ctx({
      lines: [
        makeLine({
          plan_name: '  business  unlimited  pro 2.0  ',
          plan_base_cents: 5000,
        }),
      ],
      contracts: [
        makeContract({
          terms: {
            plan_name: 'BUSINESS UNLIMITED PRO 2.0',
            contracted_monthly_rate_cents: 4000,
            discount_percentage_bps: null,
            waived_fees: null,
            promo_credit_cents: null,
            promo_duration_months: null,
            device_credit_terms: null,
            line_minimums: null,
            upgrade_fee_rules: null,
            activation_fee_rules: null,
            international_package_terms: null,
            early_termination_terms: null,
            notes: null,
          },
        }),
      ],
    });
    const findings = await contractRateMismatchRule.evaluate(c);
    expect(findings).toHaveLength(1);
  });
});
