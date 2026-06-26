import { describe, expect, it } from 'vitest';

import { aggregateSpendByCarrier } from '@/lib/dashboard/spend-by-carrier';

describe('aggregateSpendByCarrier', () => {
  it('returns an empty array when given no audits', () => {
    expect(aggregateSpendByCarrier([])).toEqual([]);
  });

  it('returns a single row when only one carrier has spend', () => {
    const result = aggregateSpendByCarrier([
      { carrier: 'verizon', total_charges_cents: 10_000 },
      { carrier: 'verizon', total_charges_cents: 25_000 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.carrier).toBe('verizon');
    expect(result[0]?.total_cents).toBe(35_000);
    expect(result[0]?.share).toBeCloseTo(1, 5);
  });

  it('aggregates a mix of carriers with correct shares', () => {
    const result = aggregateSpendByCarrier([
      { carrier: 'verizon', total_charges_cents: 60_000 },
      { carrier: 'att', total_charges_cents: 30_000 },
      { carrier: 'tmobile', total_charges_cents: 10_000 },
    ]);
    expect(result).toHaveLength(3);
    const verizon = result.find((r) => r.carrier === 'verizon');
    const att = result.find((r) => r.carrier === 'att');
    const tmobile = result.find((r) => r.carrier === 'tmobile');
    expect(verizon?.total_cents).toBe(60_000);
    expect(verizon?.share).toBeCloseTo(0.6, 5);
    expect(att?.share).toBeCloseTo(0.3, 5);
    expect(tmobile?.share).toBeCloseTo(0.1, 5);
  });

  it('strips audits whose total_charges_cents is null', () => {
    const result = aggregateSpendByCarrier([
      { carrier: 'verizon', total_charges_cents: 10_000 },
      { carrier: 'verizon', total_charges_cents: null },
      { carrier: 'att', total_charges_cents: null },
    ]);
    // att never appears because its only audit was null.
    expect(result).toHaveLength(1);
    expect(result[0]?.carrier).toBe('verizon');
    expect(result[0]?.total_cents).toBe(10_000);
  });

  it('rolls null/empty carrier under "unknown" and sorts by spend desc', () => {
    const result = aggregateSpendByCarrier([
      { carrier: null, total_charges_cents: 5_000 },
      { carrier: 'att', total_charges_cents: 50_000 },
      { carrier: '   ', total_charges_cents: 1_000 },
      { carrier: 'verizon', total_charges_cents: 20_000 },
    ]);
    expect(result.map((r) => r.carrier)).toEqual(['att', 'verizon', 'unknown']);
    const unknown = result.find((r) => r.carrier === 'unknown');
    expect(unknown?.total_cents).toBe(6_000);
  });
});
