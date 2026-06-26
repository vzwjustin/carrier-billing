import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/spectrum';
import type { ExtractedBill } from '@/extraction/schema';

// Spectrum is a Verizon MVNO and currently delegates its normalization pass
// directly to the Verizon module. These tests cover the inheritance path:
// the Verizon-specific canonicalizations should apply, and the carrier
// label is preserved as 'spectrum' rather than being rewritten to 'verizon'.

const baseBill = (): ExtractedBill => ({
  carrier: 'spectrum',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 10_000,
  notes: [],
  accounts: [
    {
      account_number_last4: '2222',
      label: 'Main',
      total_charges_cents: 10_000,
      taxes_fees_cents: 800,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '4444',
          user_label: 'Eve',
          device: 'iPhone 15',
          plan_name: null,
          plan_base_cents: 4_500,
          data_used_gb: 6,
          voice_used_min: 30,
          sms_used_count: 60,
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

describe('spectrum normalize (inherits Verizon)', () => {
  it('preserves the spectrum carrier label', () => {
    const bill = baseBill();
    const out = normalize(bill);
    expect(out.carrier).toBe('spectrum');
  });

  it('applies inherited Verizon plan canonicalization', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited plus 2.0';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Plus 2.0');
  });

  it('applies inherited Verizon feature category overrides (TravelPass → international)', () => {
    const bill = baseBill();
    firstLine(bill).features = [{ name: 'TravelPass', category: 'other', monthly_cents: 1000 }];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('international');
  });

  it('passes through unrelated data unchanged', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'Spectrum Unlimited Plus';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Spectrum Unlimited Plus');
    expect(out.total_charges_cents).toBe(10_000);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited plus 2.0';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
