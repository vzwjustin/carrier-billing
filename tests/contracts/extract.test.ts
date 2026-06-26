import { describe, expect, it } from 'vitest';

import {
  ContractTermsSchema,
  ExtractedContractSchema,
  type ExtractedContract,
} from '@/contracts/schema';

/**
 * Schema-validation tests for the contract extractor. We do NOT call the
 * real Anthropic API here — the gated LLM-roundtrip test is left as an
 * `it.todo` for the manual `RUN_LLM_TESTS=1` slot, mirroring the bill
 * extractor.
 */

describe('ContractTermsSchema', () => {
  it('accepts a fully-populated, well-formed terms payload', () => {
    const payload = {
      plan_name: 'Business Unlimited Pro 2.0',
      contracted_monthly_rate_cents: 4500,
      discount_percentage_bps: 1250,
      waived_fees: [{ name: 'activation fee', monthly_cents: 0 }, { name: 'upgrade fee' }],
      promo_credit_cents: 1000,
      promo_duration_months: 24,
      device_credit_terms: '$800 over 36 months on eligible devices',
      line_minimums: 100,
      upgrade_fee_rules: 'No upgrade fee with eligible trade-in',
      activation_fee_rules: 'Activation fee waived for the duration of the contract',
      international_package_terms: '$10/day TravelPass when in eligible countries',
      early_termination_terms: '$200 per line if terminated within 12 months',
      notes: 'Master Service Agreement #12345',
    };
    const result = ContractTermsSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts an all-null partial extraction (LLM unsure of any term)', () => {
    const payload = {
      plan_name: null,
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
    };
    const result = ContractTermsSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects a negative contracted rate (money is non-negative cents)', () => {
    const payload = {
      plan_name: 'X',
      contracted_monthly_rate_cents: -1,
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
    };
    const result = ContractTermsSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects discount_percentage_bps above 10000 (over 100%)', () => {
    const payload = {
      plan_name: null,
      contracted_monthly_rate_cents: null,
      discount_percentage_bps: 12_500,
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
    };
    const result = ContractTermsSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects an oversized notes field (defense-in-depth on log bloat)', () => {
    const payload = {
      plan_name: null,
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
      notes: 'x'.repeat(2001),
    };
    const result = ContractTermsSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('ExtractedContractSchema', () => {
  it('parses a realistic Verizon contract fixture', () => {
    const fixture: ExtractedContract = {
      header: {
        carrier: 'verizon',
        ban_last4: '4321',
        effective_date: '2026-01-01',
        expiration_date: '2028-12-31',
      },
      terms: {
        plan_name: 'Business Unlimited Pro 2.0',
        contracted_monthly_rate_cents: 4000,
        discount_percentage_bps: 1500,
        waived_fees: [{ name: 'activation fee' }],
        promo_credit_cents: null,
        promo_duration_months: null,
        device_credit_terms: 'Standard DPP terms apply',
        line_minimums: 50,
        upgrade_fee_rules: null,
        activation_fee_rules: 'Waived for the duration of the agreement',
        international_package_terms: null,
        early_termination_terms: null,
        notes: null,
      },
    };
    const result = ExtractedContractSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it('rejects a malformed ban_last4 (must be exactly 4 digits)', () => {
    const fixture = {
      header: {
        carrier: 'verizon',
        ban_last4: '12345',
        effective_date: null,
        expiration_date: null,
      },
      terms: {
        plan_name: null,
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
    };
    const result = ExtractedContractSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid carrier enum value', () => {
    const fixture = {
      header: {
        carrier: 'sprint',
        ban_last4: null,
        effective_date: null,
        expiration_date: null,
      },
      terms: {
        plan_name: null,
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
    };
    const result = ExtractedContractSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });
});

// Gated against a real Anthropic call. The fixture roundtrip would mirror
// `tests/extraction/llm.test.ts`'s RUN_LLM_TESTS=1 pattern.
it.todo('extractContract roundtrip against a real Anthropic call (RUN_LLM_TESTS=1)');
