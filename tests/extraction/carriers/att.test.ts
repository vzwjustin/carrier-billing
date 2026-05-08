import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/att';
import type { ExtractedBill } from '@/extraction/schema';

const baseBill = (): ExtractedBill => ({
  carrier: 'att',
  billing_period_start: '2026-04-01',
  billing_period_end: '2026-04-30',
  total_charges_cents: 9_999,
  notes: [],
  accounts: [
    {
      account_number_last4: '4321',
      label: 'Main',
      total_charges_cents: 9_999,
      taxes_fees_cents: 800,
      account_level_credits: [],
      lines: [
        {
          mdn_last4: '1111',
          user_label: 'Bob',
          device: 'Samsung S24',
          plan_name: null,
          plan_base_cents: 5_500,
          data_used_gb: 4,
          voice_used_min: 30,
          sms_used_count: 50,
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

describe('att normalize', () => {
  it('canonicalizes plan name variants to "Business Unlimited Premium"', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited premium';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Premium');
  });

  it('canonicalizes the Performance and Starter tiers (case-insensitive)', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'BUSINESS UNLIMITED PERFORMANCE';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Performance');

    const bill2 = baseBill();
    firstLine(bill2).plan_name = 'business unlimited starter';
    const out2 = normalize(bill2);
    expect(firstLine(out2).plan_name).toBe('Business Unlimited Starter');
  });

  it('reclassifies "AT&T Mobile Insurance" and "Mobile Protection Pack" as insurance', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      {
        name: 'AT&T Mobile Insurance',
        category: 'addon',
        monthly_cents: 899,
      },
      {
        name: 'Mobile Protection Pack',
        category: 'other',
        monthly_cents: 1500,
      },
    ];
    const out = normalize(bill);
    const features = firstLine(out).features;
    expect(features[0]?.category).toBe('insurance');
    expect(features[1]?.category).toBe('insurance');
  });

  it('reclassifies "International Day Pass" as international and "AT&T Photo Storage" as cloud', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      {
        name: 'International Day Pass',
        category: 'other',
        monthly_cents: 1000,
      },
      { name: 'AT&T Photo Storage', category: 'addon', monthly_cents: 599 },
    ];
    const out = normalize(bill);
    const features = firstLine(out).features;
    expect(features[0]?.category).toBe('international');
    expect(features[1]?.category).toBe('cloud');
  });

  it('trims and collapses internal whitespace on DPP device strings', () => {
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
    firstLine(bill).plan_name = 'Custom Enterprise Plan';
    firstLine(bill).features = [
      { name: 'Premium Voicemail', category: 'addon', monthly_cents: 199 },
    ];
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Custom Enterprise Plan');
    expect(firstLine(out).features[0]).toEqual({
      name: 'Premium Voicemail',
      category: 'addon',
      monthly_cents: 199,
    });
    expect(out.carrier).toBe('att');
    expect(out.total_charges_cents).toBe(9_999);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited premium';
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
