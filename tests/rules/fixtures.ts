import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedDpp,
  ExtractedFeature,
  ExtractedLine,
} from '@/extraction/schema';

export function makeFeature(over: Partial<ExtractedFeature> = {}): ExtractedFeature {
  return {
    name: 'Some Feature',
    category: 'other',
    monthly_cents: 500,
    ...over,
  };
}

export function makeCredit(over: Partial<ExtractedCredit> = {}): ExtractedCredit {
  return {
    name: 'Promo Credit',
    monthly_cents: -1000,
    expires_on: null,
    is_promo: true,
    ...over,
  };
}

export function makeDpp(over: Partial<ExtractedDpp> = {}): ExtractedDpp {
  return {
    device: 'iPhone 15',
    monthly_cents: 3333,
    remaining_payments: 12,
    total_payments: 36,
    ...over,
  };
}

export function makeLine(over: Partial<ExtractedLine> = {}): ExtractedLine {
  return {
    mdn_last4: '1234',
    user_label: null,
    device: 'iPhone 15',
    plan_name: 'Business Unlimited Pro 2.0',
    plan_base_cents: 4500,
    data_used_gb: 5.5,
    voice_used_min: 100,
    sms_used_count: 200,
    is_suspended: false,
    features: [],
    credits: [],
    dpp_installments: [],
    ...over,
  };
}

export function makeAccount(over: Partial<ExtractedAccount> = {}): ExtractedAccount {
  return {
    account_number_last4: '0000',
    label: 'Main Account',
    total_charges_cents: 50000,
    taxes_fees_cents: 5000,
    account_level_credits: [],
    lines: [makeLine()],
    ...over,
  };
}

export function makeBill(over: Partial<ExtractedBill> = {}): ExtractedBill {
  return {
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 50000,
    accounts: [makeAccount()],
    notes: [],
    ...over,
  };
}

/** Standard "today" used across rule tests for deterministic date math. */
export const TEST_TODAY = new Date('2026-05-08T12:00:00Z');
