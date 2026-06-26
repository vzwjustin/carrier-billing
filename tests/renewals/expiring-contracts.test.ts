import { describe, expect, it } from 'vitest';

import { findExpiringContracts, type ContractRow } from '@/lib/renewals/expiring-contracts';

const TODAY = new Date('2026-05-08T12:00:00Z');

function row(overrides: Partial<ContractRow> & { id: string }): ContractRow {
  return {
    original_filename: 'contract.pdf',
    carrier: 'verizon',
    ban_last4: '1234',
    expiration_date: null,
    contracted_monthly_rate_cents: null,
    ...overrides,
  };
}

describe('findExpiringContracts', () => {
  it('returns an empty array when given no contracts', () => {
    expect(findExpiringContracts([], TODAY)).toEqual([]);
  });

  it('excludes contracts whose expiration_date is already in the past', () => {
    const contracts: ContractRow[] = [
      row({ id: 'a', expiration_date: '2026-05-07' }), // yesterday
      row({ id: 'b', expiration_date: '2026-01-01' }), // months ago
      row({ id: 'c', expiration_date: '2024-12-31' }), // years ago
    ];
    expect(findExpiringContracts(contracts, TODAY)).toEqual([]);
  });

  it('returns only contracts within the window, sorted soonest first', () => {
    const contracts: ContractRow[] = [
      row({ id: 'far', expiration_date: '2027-01-01' }), // far future
      row({ id: 'soon', expiration_date: '2026-05-20' }), // 12 days out
      row({ id: 'mid', expiration_date: '2026-07-15' }), // ~68 days out
      row({ id: 'past', expiration_date: '2026-04-01' }), // expired
    ];
    const result = findExpiringContracts(contracts, TODAY);
    expect(result.map((r) => r.id)).toEqual(['soon', 'mid']);
    expect(result[0]?.days_until_expiration).toBe(12);
    expect(result[1]?.days_until_expiration).toBe(68);
  });

  it('includes contracts expiring exactly on the boundary day', () => {
    // Default window is 90 days; '2026-08-06' is exactly 90 days out.
    const contracts: ContractRow[] = [
      row({ id: 'edge', expiration_date: '2026-08-06' }), // delta = 90
      row({ id: 'over', expiration_date: '2026-08-07' }), // delta = 91
      row({ id: 'today', expiration_date: '2026-05-08' }), // delta = 0
    ];
    const result = findExpiringContracts(contracts, TODAY);
    expect(result.map((r) => r.id)).toEqual(['today', 'edge']);
    expect(result[0]?.days_until_expiration).toBe(0);
    expect(result[1]?.days_until_expiration).toBe(90);
  });

  it('skips contracts with null expiration_date and surfaces only the expiring one', () => {
    const contracts: ContractRow[] = [
      row({ id: 'noexp', expiration_date: null }),
      row({ id: 'expired', expiration_date: '2026-03-01' }),
      row({ id: 'expiring', expiration_date: '2026-06-01' }),
    ];
    const result = findExpiringContracts(contracts, TODAY);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('expiring');
  });
});
