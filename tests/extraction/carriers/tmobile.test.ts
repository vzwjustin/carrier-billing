import { describe, it, expect } from 'vitest';
import { normalize } from '@/extraction/carriers/tmobile';
import type { ExtractedBill } from '@/extraction/schema';

const baseBill = (): ExtractedBill => ({
  carrier: 'tmobile',
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

describe('tmobile normalize', () => {
  it('canonicalizes plan name "business unlimited ultimate" to "Business Unlimited Ultimate"', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited ultimate';
    const out = normalize(bill);
    expect(firstLine(out).plan_name).toBe('Business Unlimited Ultimate');
  });

  it('canonicalizes "BUSINESS UNLIMITED ADVANCED" and "  business unlimited select  "', () => {
    const a = baseBill();
    firstLine(a).plan_name = 'BUSINESS UNLIMITED ADVANCED';
    expect(firstLine(normalize(a)).plan_name).toBe('Business Unlimited Advanced');

    const b = baseBill();
    firstLine(b).plan_name = '  business unlimited select  ';
    expect(firstLine(normalize(b)).plan_name).toBe('Business Unlimited Select');
  });

  it('reclassifies "Protection<360>" and "Protection 360" as insurance', () => {
    const a = baseBill();
    firstLine(a).features = [{ name: 'Protection<360>', category: 'addon', monthly_cents: 1500 }];
    expect(firstLine(normalize(a)).features[0]?.category).toBe('insurance');

    const b = baseBill();
    firstLine(b).features = [{ name: 'Protection 360', category: 'other', monthly_cents: 1500 }];
    expect(firstLine(normalize(b)).features[0]?.category).toBe('insurance');
  });

  it('reclassifies "Premium Handset Protection" as insurance and "Magenta International" as international', () => {
    const bill = baseBill();
    firstLine(bill).features = [
      {
        name: 'Premium Handset Protection',
        category: 'addon',
        monthly_cents: 1200,
      },
      {
        name: 'Magenta International',
        category: 'other',
        monthly_cents: 1500,
      },
    ];
    const features = firstLine(normalize(bill)).features;
    expect(features[0]?.category).toBe('insurance');
    expect(features[1]?.category).toBe('international');
  });

  it('flags "Bill Credit" as is_promo even when LLM omitted the flag', () => {
    const bill = baseBill();
    firstLine(bill).credits = [
      {
        name: 'Bill Credit',
        monthly_cents: -1500,
        expires_on: null,
        is_promo: false,
      },
    ];
    const out = normalize(bill);
    expect(firstLine(out).credits[0]?.is_promo).toBe(true);
    expect(firstLine(out).credits[0]?.name).toBe('Bill Credit');
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
    expect(out.carrier).toBe('tmobile');
    expect(out.billing_period_start).toBe('2026-04-01');
    expect(out.total_charges_cents).toBe(12_345);
  });

  it('does not mutate the input bill', () => {
    const bill = baseBill();
    firstLine(bill).plan_name = 'business unlimited ultimate';
    firstLine(bill).features = [
      { name: 'Protection<360>', category: 'addon', monthly_cents: 1500 },
    ];
    const snapshot = JSON.parse(JSON.stringify(bill));
    normalize(bill);
    expect(bill).toEqual(snapshot);
  });
});
