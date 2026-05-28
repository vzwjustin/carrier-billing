import { describe, expect, it } from 'vitest';

import { compareBills } from '@/autopsy/compare';
import {
  makeAccount,
  makeBill,
  makeCredit,
  makeDpp,
  makeFeature,
  makeLine,
} from '../rules/fixtures';

describe('compareBills — Bill Increase Autopsy engine', () => {
  it('returns zero net change when the two bills are identical', () => {
    const bill = makeBill();
    const result = compareBills(bill, bill);
    expect(result.net_change_cents).toBe(0);
    expect(result.previous_total_cents).toBe(bill.total_charges_cents);
    expect(result.current_total_cents).toBe(bill.total_charges_cents);
    expect(result.drivers).toHaveLength(0);
    expect(result.executive_summary).toMatch(/unchanged/i);
    expect(result.disputable_cents).toBe(0);
    expect(result.optimization_cents).toBe(0);
    expect(result.unexplained_cents).toBe(0);
  });

  it('attributes a new line as a "new_lines" driver', () => {
    const prev = makeBill({
      total_charges_cents: 9000,
      accounts: [makeAccount({ lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500 })] })],
    });
    const curr = makeBill({
      total_charges_cents: 13500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({ mdn_last4: '1111', plan_base_cents: 4500 }),
            makeLine({ mdn_last4: '2222', plan_base_cents: 4500 }),
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(4500);
    const newLines = result.drivers.find((d) => d.category === 'new_lines');
    expect(newLines).toBeDefined();
    expect(newLines?.difference_cents).toBe(4500);
    expect(newLines?.affected_lines_count).toBe(1);
  });

  it('attributes a removed line as a "removed_lines" driver (negative diff)', () => {
    const prev = makeBill({
      total_charges_cents: 13500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({ mdn_last4: '1111', plan_base_cents: 4500 }),
            makeLine({ mdn_last4: '2222', plan_base_cents: 4500 }),
          ],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 9000,
      accounts: [makeAccount({ lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500 })] })],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(-4500);
    const removed = result.drivers.find((d) => d.category === 'removed_lines');
    expect(removed?.difference_cents).toBe(-4500);
  });

  it('attributes a disappeared promo credit as missing_credits AND marks it disputable', () => {
    const credit = makeCredit({
      name: 'Loyalty Promo',
      monthly_cents: -2500,
      expires_on: null,
    });
    const prev = makeBill({
      total_charges_cents: 7000,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              plan_base_cents: 4500,
              credits: [credit],
            }),
          ],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 9500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [] }),
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(2500);
    const missing = result.drivers.find((d) => d.category === 'missing_credits');
    expect(missing).toBeDefined();
    expect(missing?.difference_cents).toBe(2500);
    expect(missing?.is_disputable).toBe(true);
    expect(result.disputable_cents).toBe(2500);
  });

  it('classifies a new device installment as device_installments_added', () => {
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, dpp_installments: [] })],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 7333,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              plan_base_cents: 4500,
              dpp_installments: [
                makeDpp({ device: 'iPhone 16 Pro', monthly_cents: 2833 }),
              ],
            }),
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(2833);
    const dppAdded = result.drivers.find(
      (d) => d.category === 'device_installments_added',
    );
    expect(dppAdded?.difference_cents).toBe(2833);
  });

  it('classifies a plan-base change as plan_changes', () => {
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              plan_base_cents: 4500,
              plan_name: 'Business Unlimited Start 2.0',
            }),
          ],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 6500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              plan_base_cents: 6500,
              plan_name: 'Business Unlimited Plus 2.0',
            }),
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(2000);
    const planChange = result.drivers.find((d) => d.category === 'plan_changes');
    expect(planChange?.difference_cents).toBe(2000);
    expect(planChange?.evidence.lines?.[0]?.note).toMatch(/Business Unlimited Start 2\.0/);
  });

  it('classifies an insurance feature add as insurance_changes (optimization bucket)', () => {
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [makeAccount({ lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, features: [] })] })],
    });
    const curr = makeBill({
      total_charges_cents: 6200,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              mdn_last4: '1111',
              plan_base_cents: 4500,
              features: [
                makeFeature({
                  name: 'Mobile Protect insurance',
                  category: 'insurance',
                  monthly_cents: 1700,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    const ins = result.drivers.find((d) => d.category === 'insurance_changes');
    expect(ins?.difference_cents).toBe(1700);
    expect(ins?.is_optimization).toBe(true);
    expect(result.optimization_cents).toBe(1700);
  });

  it('classifies an international feature change as international_charges', () => {
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [makeAccount({ lines: [makeLine({ plan_base_cents: 4500, features: [] })] })],
    });
    const curr = makeBill({
      total_charges_cents: 5500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              plan_base_cents: 4500,
              features: [
                makeFeature({
                  name: 'International Travel Pass',
                  category: 'international',
                  monthly_cents: 1000,
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const intl = compareBills(prev, curr).drivers.find(
      (d) => d.category === 'international_charges',
    );
    expect(intl).toBeDefined();
    expect(intl?.difference_cents).toBe(1000);
  });

  it('emits a taxes_fees_change driver with account-level evidence', () => {
    const prev = makeBill({
      total_charges_cents: 50000,
      accounts: [
        makeAccount({
          account_number_last4: '7777',
          total_charges_cents: 50000,
          taxes_fees_cents: 5000,
          lines: [makeLine()],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 51500,
      accounts: [
        makeAccount({
          account_number_last4: '7777',
          total_charges_cents: 51500,
          taxes_fees_cents: 6500,
          lines: [makeLine()],
        }),
      ],
    });
    const taxes = compareBills(prev, curr).drivers.find(
      (d) => d.category === 'taxes_fees_change',
    );
    expect(taxes).toBeDefined();
    expect(taxes?.difference_cents).toBe(1500);
    expect(taxes?.evidence.accounts?.[0]?.account_last4).toBe('7777');
  });

  it('emits a suspended_line_still_billed driver when the current bill keeps charging a suspended line', () => {
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, is_suspended: false })],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, is_suspended: true })],
        }),
      ],
    });
    const susp = compareBills(prev, curr).drivers.find(
      (d) => d.category === 'suspended_line_still_billed',
    );
    expect(susp).toBeDefined();
    expect(susp?.is_disputable).toBe(true);
    expect(susp?.confidence).toBeGreaterThan(0.9);
  });

  it('records an unexplained residual when bill total moves more than the categorized drivers', () => {
    // Drivers explain $2500 (missing credit), bill total moves $5000 — $2500 is unexplained.
    const credit = makeCredit({
      name: 'Loyalty',
      monthly_cents: -2500,
      expires_on: null,
    });
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [credit] })],
        }),
      ],
    });
    const curr = makeBill({
      // Engineered: bill total claims +5000 but only $2500 of drivers exist.
      total_charges_cents: 9500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [] })],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.net_change_cents).toBe(5000);
    const unexp = result.drivers.find((d) => d.category === 'unexplained');
    expect(unexp).toBeDefined();
    expect(unexp?.difference_cents).toBe(2500); // residual after the $2500 missing credit
    expect(unexp?.is_unexplained).toBe(true);
    expect(result.unexplained_cents).toBeGreaterThan(0);
  });

  it('drivers are sorted by absolute impact descending', () => {
    const credit = makeCredit({ name: 'Big Promo', monthly_cents: -5000, expires_on: null });
    const prev = makeBill({
      total_charges_cents: 9000,
      accounts: [
        makeAccount({
          lines: [
            makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [credit] }),
            makeLine({ mdn_last4: '2222', plan_base_cents: 4500 }),
          ],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 18500,
      accounts: [
        makeAccount({
          lines: [
            makeLine({ mdn_last4: '1111', plan_base_cents: 4500 }), // credit disappeared (+5000)
            makeLine({ mdn_last4: '2222', plan_base_cents: 4500 }),
            makeLine({ mdn_last4: '3333', plan_base_cents: 4500 }), // new line (+4500)
          ],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    const impacts = result.drivers.map((d) => Math.abs(d.difference_cents));
    const sortedDesc = [...impacts].sort((a, b) => b - a);
    expect(impacts).toEqual(sortedDesc);
  });

  it('executive summary lists top drivers with sign + amount', () => {
    const credit = makeCredit({ name: 'Promo', monthly_cents: -2500, expires_on: null });
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [credit] })],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 7000,
      accounts: [
        makeAccount({
          lines: [makeLine({ mdn_last4: '1111', plan_base_cents: 4500, credits: [] })],
        }),
      ],
    });
    const summary = compareBills(prev, curr).executive_summary;
    expect(summary).toMatch(/increased/);
    expect(summary).toMatch(/\$25\.00/);
    expect(summary).toMatch(/potentially disputable/);
  });

  it('matches lines positionally when MDN is null on both sides', () => {
    // Both bills have one account with one line, both MDNs null. The
    // engine should match positionally and detect the plan change, not
    // emit one new_line + one removed_line.
    const prev = makeBill({
      total_charges_cents: 4500,
      accounts: [
        makeAccount({
          account_number_last4: null,
          lines: [makeLine({ mdn_last4: null, plan_base_cents: 4500, plan_name: 'Starter' })],
        }),
      ],
    });
    const curr = makeBill({
      total_charges_cents: 6500,
      accounts: [
        makeAccount({
          account_number_last4: null,
          lines: [makeLine({ mdn_last4: null, plan_base_cents: 6500, plan_name: 'Plus' })],
        }),
      ],
    });
    const result = compareBills(prev, curr);
    expect(result.drivers.find((d) => d.category === 'new_lines')).toBeUndefined();
    expect(result.drivers.find((d) => d.category === 'removed_lines')).toBeUndefined();
    expect(result.drivers.find((d) => d.category === 'plan_changes')).toBeDefined();
  });

  it('percent_change_bps is null when previous total is zero (new account)', () => {
    const prev = makeBill({ total_charges_cents: 0, accounts: [makeAccount({ lines: [] })] });
    const curr = makeBill({
      total_charges_cents: 4500,
      accounts: [makeAccount({ lines: [makeLine({ plan_base_cents: 4500 })] })],
    });
    expect(compareBills(prev, curr).percent_change_bps).toBeNull();
  });
});
