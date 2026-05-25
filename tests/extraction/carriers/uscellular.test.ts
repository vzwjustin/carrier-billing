import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/uscellular';
import type { ExtractedBill } from '@/extraction/schema';

const baseBill = (): ExtractedBill => ({
  carrier: 'uscellular',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 8_500,
  notes: [],
  accounts: [
    {
      account_number_last4: '7777',
      label: 'Main',
      total_charges_cents: 8_500,
      taxes_fees_cents: 700,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '4321',
          user_label: 'Dana',
          device: 'iPhone 15',
          plan_name: null,
          plan_base_cents: 5_000,
          data_used_gb: 8,
          voice_used_min: 50,
          sms_used_count: 100,
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

describe('uscellular normalize', () => {
  it('canonicalizes plan name variants to "Business Unlimited Everyday"', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited everyday';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Everyday');
  });

  it('canonicalizes "BUSINESS UNLIMITED PREMIUM" (case-insensitive)', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'BUSINESS UNLIMITED PREMIUM';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Premium');
  });

  it('reclassifies "Device Protection+" as insurance', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      { name: 'Device Protection+', category: 'addon', monthly_cents: 999 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('insurance');
  });

  it('reclassifies "International Connect" as international', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      { name: 'International Connect', category: 'other', monthly_cents: 500 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).features[0]?.category).toBe('international');
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
    expect(out.carrier).toBe('uscellular');
    expect(out.total_charges_cents).toBe(8_500);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited everyday';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
