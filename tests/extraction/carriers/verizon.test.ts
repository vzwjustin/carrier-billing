import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/verizon';
import type { ExtractedBill } from '@/extraction/schema';

const baseBill = (): ExtractedBill => ({
  carrier: 'verizon',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 12_345,
  notes: [],
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
          plan_name: null,
          plan_base_cents: 6_000,
          data_used_gb: 10,
          voice_used_min: 0,
          sms_used_count: 0,
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

describe('verizon normalize', () => {
  it('canonicalizes plan name variants to "Business Unlimited Pro 2.0"', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited pro 2.0';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Pro 2.0');
  });

  it('canonicalizes "Business Unlimited Plus 20" (missing decimal) to canonical', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'BUSINESS UNLIMITED PLUS 20';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Plus 2.0');
  });

  it('reclassifies "Verizon Cloud Business" feature as cloud', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      { name: 'Verizon Cloud Business', category: 'addon', monthly_cents: 599 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('cloud');
  });

  it('reclassifies "TravelPass" as international and "Mobile Protect" as insurance', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      { name: 'TravelPass', category: 'other', monthly_cents: 1000 },
      {
        name: 'Total Mobile Protection',
        category: 'addon',
        monthly_cents: 1500,
      },
    ];
    const out = normalize(bill);
    const features = firstLine(out).features;
    expect(features[0]?.category).toBe('international');
    expect(features[1]?.category).toBe('insurance');
  });

  it('title-cases "loyalty discount" credit names and trims whitespace', () => {
    const bill = baseBill();
    firstLine(bill).credits = [
      {
        name: '  loyalty discount  ',
        monthly_cents: -500,
        expires_on: null,
        is_promo: true,
      },
    ];
    const out = normalize(bill);
    expect(firstLine(out).credits[0]?.name).toBe('Loyalty Discount');
  });

  it('passes through unrelated data unchanged', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'Some Custom Legacy Plan';
    firstLine(bill).features = [
      { name: 'Premium Voicemail', category: 'addon', monthly_cents: 199 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Some Custom Legacy Plan');
    expect(firstLine(out).features[0]).toEqual({
      name: 'Premium Voicemail',
      category: 'addon',
      monthly_cents: 199,
    });
    // Top-level fields untouched.
    expect(out.carrier).toBe('verizon');
    expect(out.billing_period_start).toBe('2026-04-01');
    expect(out.total_charges_cents).toBe(12_345);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited pro 2.0';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
