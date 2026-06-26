import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/xfinity';
import type { ExtractedBill } from '@/extraction/schema';

// Xfinity Mobile is a Verizon MVNO and currently delegates its normalization
// pass directly to the Verizon module. These tests cover the inheritance
// path and confirm the carrier label is preserved as 'xfinity'.

const baseBill = (): ExtractedBill => ({
  carrier: 'xfinity',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 7_500,
  notes: [],
  accounts: [
    {
      account_number_last4: '3333',
      label: 'Main',
      total_charges_cents: 7_500,
      taxes_fees_cents: 600,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '5555',
          user_label: 'Frank',
          device: 'Samsung S24',
          plan_name: null,
          plan_base_cents: 4_000,
          data_used_gb: 3,
          voice_used_min: 25,
          sms_used_count: 40,
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

describe('xfinity normalize (inherits Verizon)', () => {
  it('preserves the xfinity carrier label', () => {
    const bill = baseBill();
    const out = normalize(bill);
    expect(out.carrier).toBe('xfinity');
  });

  it('applies inherited Verizon plan canonicalization', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited pro 2.0';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Pro 2.0');
  });

  it('applies inherited Verizon Cloud feature reclassification', () => {
    const bill = baseBill();
    firstLine(bill).features = [{ name: 'Verizon Cloud', category: 'addon', monthly_cents: 599 }];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('cloud');
  });

  it('passes through unrelated data unchanged', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'Xfinity By the Gig';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Xfinity By the Gig');
    expect(out.total_charges_cents).toBe(7_500);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited pro 2.0';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
