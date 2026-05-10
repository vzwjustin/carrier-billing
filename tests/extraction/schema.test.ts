import { describe, it, expect } from 'vitest';
import { ExtractedBillSchema } from '@/extraction/schema';

type MinimalBill = {
  carrier: string;
  billing_period_start: string;
  billing_period_end: string;
  total_charges_cents: number;
  accounts: Array<{
    account_number_last4: string | null;
    label: string | null;
    total_charges_cents: number;
    taxes_fees_cents: number | null;
    account_level_credits: Array<Record<string, unknown>>;
    lines: Array<{
      mdn_last4: string | null;
      user_label: string | null;
      device: string | null;
      plan_name: string | null;
      plan_base_cents: number | null;
      data_used_gb: number | null;
      voice_used_min: number | null;
      sms_used_count: number | null;
      is_suspended: boolean;
      features: Array<Record<string, unknown>>;
      credits: Array<Record<string, unknown>>;
      dpp_installments: Array<Record<string, unknown>>;
    }>;
  }>;
  notes: string[];
};

const minimalBill = (): MinimalBill => ({
  carrier: 'verizon',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 12_345,
  accounts: [
    {
      account_number_last4: '1234',
      label: 'Main',
      total_charges_cents: 12_345,
      taxes_fees_cents: 1_000,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '5678',
          user_label: 'Alice',
          device: 'iPhone 15',
          plan_name: 'Business Unlimited Pro 2.0',
          plan_base_cents: 6_000,
          data_used_gb: 10.25,
          voice_used_min: 200,
          sms_used_count: 100,
          is_suspended: false,
          features: [],
          credits: [],
          dpp_installments: [],
        },
      ],
    },
  ],
  notes: [],
});

describe('ExtractedBillSchema', () => {
  it('parses a valid minimal bill', () => {
    const result = ExtractedBillSchema.safeParse(minimalBill());
    expect(result.success).toBe(true);
  });

  it('rejects when a required top-level field is missing', () => {
    const bill = minimalBill() as Partial<ReturnType<typeof minimalBill>>;
    delete bill.billing_period_start;
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid date format', () => {
    const bill = minimalBill();
    bill.billing_period_start = '04/01/2026';
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects a negative monthly_cents on a feature (features are non-negative)', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    const firstLine = firstAccount.lines[0];
    if (!firstLine) throw new Error('fixture missing line');
    firstLine.features = [
      { name: 'Mobile Protect', category: 'insurance', monthly_cents: -1500 },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('accepts a negative monthly_cents on a credit (credits are signed)', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    const firstLine = firstAccount.lines[0];
    if (!firstLine) throw new Error('fixture missing line');
    firstLine.credits = [
      {
        name: 'Loyalty discount',
        monthly_cents: -1000,
        expires_on: '2026-12-31',
        is_promo: true,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
  });

  it('accepts a zero monthly_cents on a credit (rare placeholder credit)', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    const firstLine = firstAccount.lines[0];
    if (!firstLine) throw new Error('fixture missing line');
    firstLine.credits = [
      {
        name: 'Pending Promo',
        monthly_cents: 0,
        expires_on: null,
        is_promo: true,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
  });

  it('rejects a positive monthly_cents on a credit (credits must be 0 or negative)', () => {
    // Guards against an LLM/extraction sign flip that would silently turn a
    // $10 discount into a $10 charge once treated as signed elsewhere.
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    const firstLine = firstAccount.lines[0];
    if (!firstLine) throw new Error('fixture missing line');
    firstLine.credits = [
      {
        name: 'Wrong-sign credit',
        monthly_cents: 1000,
        expires_on: '2026-12-31',
        is_promo: true,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects a positive monthly_cents on an account-level credit', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    firstAccount.account_level_credits = [
      {
        name: 'Wrong-sign account credit',
        monthly_cents: 2500,
        expires_on: null,
        is_promo: true,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects an empty accounts array', () => {
    const bill = minimalBill();
    bill.accounts = [];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  // Regression for CLAUDE.md §11 #12: schema deliberately allows
  // accounts-with-no-lines so we can surface a domain-specific failure
  // ('no lines extracted') from process-bill's runtime guard rather than a
  // generic schema error. If this test starts failing because someone added
  // `.min(1)` to ExtractedAccountSchema.lines, also delete the runtime guard
  // in src/inngest/functions/process-bill.ts and update its failure_reason.
  it('accepts accounts with zero lines (runtime guard is responsible)', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    firstAccount.lines = [];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const totalLines = result.data.accounts.reduce(
      (sum, a) => sum + a.lines.length,
      0,
    );
    // process-bill.ts throws Error('no lines extracted') iff this is 0.
    expect(totalLines).toBe(0);
  });

  it('rejects mdn_last4 of wrong length', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    const firstLine = firstAccount.lines[0];
    if (!firstLine) throw new Error('fixture missing line');
    firstLine.mdn_last4 = '123';
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects account_number_last4 with non-digits', () => {
    const bill = minimalBill();
    const firstAccount = bill.accounts[0];
    if (!firstAccount) throw new Error('fixture missing account');
    firstAccount.account_number_last4 = '12ab';
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────
  // (M-E1) String length caps. The schema is the contract — bounding here
  // protects every downstream consumer (Sentry, PDF report, persistence)
  // from a model leak of multi-KB strings.
  // ─────────────────────────────────────────────────────────────────────
  it('rejects a feature name longer than 120 chars', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.features = [
      {
        name: 'F'.repeat(121),
        category: 'addon',
        monthly_cents: 100,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('accepts a feature name at exactly 120 chars', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.features = [
      {
        name: 'F'.repeat(120),
        category: 'addon',
        monthly_cents: 100,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
  });

  it('rejects a credit name longer than 120 chars', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.credits = [
      {
        name: 'C'.repeat(121),
        monthly_cents: -100,
        expires_on: null,
        is_promo: true,
      },
    ];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects a plan_name longer than 120 chars', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.plan_name = 'P'.repeat(121);
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects a notes entry longer than 500 chars', () => {
    const bill = minimalBill();
    bill.notes = ['n'.repeat(501)];
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('rejects a notes array with more than 50 entries', () => {
    const bill = minimalBill();
    bill.notes = Array.from({ length: 51 }, (_v, i) => `note ${i}`);
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('accepts a notes array with exactly 50 entries each up to 500 chars', () => {
    const bill = minimalBill();
    bill.notes = Array.from({ length: 50 }, () => 'n'.repeat(500));
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // (L) data_used_gb absolute upper bound. 10TB is far above any real
  // cellular plan; values past that cap are almost always parse errors.
  // ─────────────────────────────────────────────────────────────────────
  it('rejects data_used_gb above 10,000', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.data_used_gb = 10_001;
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(false);
  });

  it('accepts data_used_gb at exactly 10,000', () => {
    const bill = minimalBill();
    const line = bill.accounts[0]!.lines[0]!;
    line.data_used_gb = 10_000;
    const result = ExtractedBillSchema.safeParse(bill);
    expect(result.success).toBe(true);
  });
});
