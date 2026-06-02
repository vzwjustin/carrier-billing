import { describe, expect, it } from 'vitest';

import { aggregateFindingsOverTime, SEVERITY_ORDER } from '@/lib/dashboard/findings-over-time';

describe('aggregateFindingsOverTime', () => {
  it('returns an empty array when given no audits', () => {
    expect(aggregateFindingsOverTime([], [])).toEqual([]);
  });

  it('returns one row with zero counts when audit has no findings', () => {
    const result = aggregateFindingsOverTime(
      [{ id: 'a1', created_at: '2026-01-01T00:00:00Z' }],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.audit_id).toBe('a1');
    expect(result[0]?.counts).toEqual({ high: 0, medium: 0, low: 0, info: 0 });
    expect(result[0]?.total).toBe(0);
  });

  it('truncates to the most recent 6 audits and orders oldest→newest', () => {
    // Input is newest-first (matches the dashboard query). Audit a8 is the
    // newest; a3 should be the oldest in the window of 6.
    const audits = Array.from({ length: 8 }, (_, i) => ({
      id: `a${8 - i}`, // a8, a7, a6, ..., a1
      created_at: `2026-01-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
    }));
    const result = aggregateFindingsOverTime(audits, []);
    expect(result).toHaveLength(6);
    // After truncation to first 6 (newest 6 = a8..a3) and reversal, output
    // should read oldest → newest: a3, a4, a5, a6, a7, a8.
    expect(result.map((r) => r.audit_id)).toEqual(['a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
  });

  it('returns all-zero counts when audits exist but have zero findings', () => {
    const result = aggregateFindingsOverTime(
      [
        { id: 'a1', created_at: '2026-01-01T00:00:00Z' },
        { id: 'a2', created_at: '2026-01-02T00:00:00Z' },
      ],
      [],
    );
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.total === 0)).toBe(true);
    expect(
      result.every(
        (r) =>
          r.counts.high === 0 && r.counts.medium === 0 && r.counts.low === 0 && r.counts.info === 0,
      ),
    ).toBe(true);
  });

  it('counts findings by severity in the canonical high→info order', () => {
    // Stack/legend order must always be high, medium, low, info.
    expect(SEVERITY_ORDER).toEqual(['high', 'medium', 'low', 'info']);

    const result = aggregateFindingsOverTime(
      [{ id: 'a1', created_at: '2026-01-01T00:00:00Z' }],
      [
        { audit_id: 'a1', severity: 'high' },
        { audit_id: 'a1', severity: 'high' },
        { audit_id: 'a1', severity: 'medium' },
        { audit_id: 'a1', severity: 'low' },
        { audit_id: 'a1', severity: 'info' },
        { audit_id: 'a1', severity: 'info' },
        // Unknown severities (defensive against future enum drift) are ignored.
        { audit_id: 'a1', severity: 'critical' },
        // Findings for unrelated audits are also ignored.
        { audit_id: 'other', severity: 'high' },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.counts).toEqual({
      high: 2,
      medium: 1,
      low: 1,
      info: 2,
    });
    expect(result[0]?.total).toBe(6);
    // Iteration order on the counts object follows SEVERITY_ORDER.
    expect(Object.keys(result[0]!.counts)).toEqual(['high', 'medium', 'low', 'info']);
  });
});
