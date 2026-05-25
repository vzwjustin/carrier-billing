import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/cricket';
import type { ExtractedBill } from '@/extraction/schema';

// Cricket Wireless is an AT&T MVNO and currently delegates its normalization
// pass directly to the AT&T module. These tests cover the inheritance path
// and confirm the carrier label is preserved as 'cricket'.

const baseBill = (): ExtractedBill => ({
  carrier: 'cricket',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 6_000,
  notes: [],
  accounts: [
    {
      account_number_last4: '9999',
      label: 'Main',
      total_charges_cents: 6_000,
      taxes_fees_cents: 500,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '8888',
          user_label: 'Grace',
          device: 'Pixel 8',
          plan_name: null,
          plan_base_cents: 3_500,
          data_used_gb: 4,
          voice_used_min: 60,
          sms_used_count: 80,
          is_suspended: false,
          features: [],
          credits: [],
          dpp_installments: [],
        },
      ],
    },
  ],
});

function firstLine(bill: ExtractedBill) {
  const account = bill.accounts[0];
  if (!account) throw new Error('fixture missing account');
  const line = account.lines[0];
  if (!line) throw new Error('fixture missing line');
  return line;
}

describe('cricket normalize (inherits AT&T)', () => {
  it('preserves the cricket carrier label', () => {
    const bill = baseBill();
    const out = normalize(bill);
    expect(out.carrier).toBe('cricket');
  });

  it('applies inherited AT&T plan canonicalization', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited premium';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Premium');
  });

  it('applies inherited AT&T International Day Pass reclassification', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      { name: 'International Day Pass', category: 'other', monthly_cents: 1000 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('international');
  });

  it('applies inherited AT&T DPP whitespace collapse', () => {
    const bill = baseBill();
    firstLine(bill).dpp_installments = [
      {
        device: '  iPhone   15   Pro  ',
        monthly_cents: 3333,
        remaining_payments: 12,
        total_payments: 36,
      },
    ];
    const out = normalize(bill);
    expect(firstLine(out).dpp_installments[0]?.device).toBe('iPhone 15 Pro');
  });

  it('passes through unrelated data unchanged', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'Cricket Core';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Cricket Core');
    expect(out.total_charges_cents).toBe(6_000);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited premium';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
