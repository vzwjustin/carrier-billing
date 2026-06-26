import { describe, expect, it } from 'vitest';

import { UNASSIGNED_LABEL, aggregateCostCenters } from '@/lib/cost-centers/aggregate';

describe('aggregateCostCenters', () => {
  it('returns an empty array when given no lines', () => {
    expect(aggregateCostCenters([])).toEqual([]);
  });

  it('groups lines by cost_center and sums plan_base_cents', () => {
    const result = aggregateCostCenters([
      { cost_center: 'Sales', plan_base_cents: 4000 },
      { cost_center: 'Sales', plan_base_cents: 6000 },
      { cost_center: 'Engineering', plan_base_cents: 3000 },
    ]);

    expect(result).toHaveLength(2);
    const sales = result.find((r) => r.cost_center === 'Sales');
    expect(sales).toBeDefined();
    expect(sales?.line_count).toBe(2);
    expect(sales?.monthly_total_cents).toBe(10_000);

    const eng = result.find((r) => r.cost_center === 'Engineering');
    expect(eng?.line_count).toBe(1);
    expect(eng?.monthly_total_cents).toBe(3_000);
  });

  it('rolls NULL cost_center under "(unassigned)"', () => {
    const result = aggregateCostCenters([
      { cost_center: null, plan_base_cents: 1500 },
      { cost_center: null, plan_base_cents: 2500 },
      { cost_center: 'Ops', plan_base_cents: 9000 },
    ]);
    const unassigned = result.find((r) => r.cost_center === UNASSIGNED_LABEL);
    expect(unassigned).toBeDefined();
    expect(unassigned?.line_count).toBe(2);
    expect(unassigned?.monthly_total_cents).toBe(4_000);
  });

  it('treats empty/whitespace cost_center as unassigned', () => {
    const result = aggregateCostCenters([
      { cost_center: '', plan_base_cents: 100 },
      { cost_center: '   ', plan_base_cents: 200 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.cost_center).toBe(UNASSIGNED_LABEL);
    expect(result[0]?.line_count).toBe(2);
    expect(result[0]?.monthly_total_cents).toBe(300);
  });

  it('treats NULL plan_base_cents as zero', () => {
    const result = aggregateCostCenters([
      { cost_center: 'A', plan_base_cents: null },
      { cost_center: 'A', plan_base_cents: 5000 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.line_count).toBe(2);
    expect(result[0]?.monthly_total_cents).toBe(5_000);
  });

  it('computes share as a fraction of total monthly cents', () => {
    const result = aggregateCostCenters([
      { cost_center: 'A', plan_base_cents: 7500 },
      { cost_center: 'B', plan_base_cents: 2500 },
    ]);
    const a = result.find((r) => r.cost_center === 'A');
    const b = result.find((r) => r.cost_center === 'B');
    expect(a?.share).toBeCloseTo(0.75, 5);
    expect(b?.share).toBeCloseTo(0.25, 5);
  });

  it('returns share=0 for all rows when total is zero', () => {
    const result = aggregateCostCenters([
      { cost_center: 'A', plan_base_cents: 0 },
      { cost_center: 'B', plan_base_cents: null },
    ]);
    expect(result.every((r) => r.share === 0)).toBe(true);
  });

  it('sorts by monthly_total_cents desc, then alphabetical for ties', () => {
    const result = aggregateCostCenters([
      { cost_center: 'Zeta', plan_base_cents: 5000 },
      { cost_center: 'Alpha', plan_base_cents: 5000 },
      { cost_center: 'Beta', plan_base_cents: 10_000 },
    ]);
    expect(result.map((r) => r.cost_center)).toEqual(['Beta', 'Alpha', 'Zeta']);
  });

  it('does not specially position the "(unassigned)" bucket', () => {
    // Unassigned dominates spend → sorts first by monthly_total_cents desc.
    const result = aggregateCostCenters([
      { cost_center: null, plan_base_cents: 20_000 },
      { cost_center: 'Ops', plan_base_cents: 1_000 },
    ]);
    expect(result[0]?.cost_center).toBe(UNASSIGNED_LABEL);
    expect(result[1]?.cost_center).toBe('Ops');
  });
});
