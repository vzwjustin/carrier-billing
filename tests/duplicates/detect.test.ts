import { describe, expect, it } from 'vitest';
import {
  buildDetectorInput,
  detectCrossAuditDuplicates,
  DUPLICATE_RULE_IDS,
} from '@/duplicates/detect';
import { makeAccount, makeBill, makeFeature, makeLine } from '../rules/fixtures';

describe('detectCrossAuditDuplicates — pure detector', () => {
  it('returns no findings when no features duplicate', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'TravelPass', monthly_cents: 1000 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'Cloud Storage', monthly_cents: 500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toEqual([]);
  });

  it('fires within-audit (high) when two different lines in one account carry an identical feature', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'TravelPass Daily', monthly_cents: 1000 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'TravelPass Daily', monthly_cents: 1000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.rule_id).toBe(DUPLICATE_RULE_IDS.within);
    expect(f.severity).toBe('high');
    expect(f.estimated_monthly_savings_cents).toBe(1000); // 2 occurrences → keep 1, recover 1
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.affected_line_indexes.sort()).toEqual([0, 1]);
    const ev = f.evidence as { occurrence_count: number; same_line: boolean };
    expect(ev.occurrence_count).toBe(2);
    expect(ev.same_line).toBe(false);
  });

  it('fires within-audit (high) when the same line carries the SAME feature twice', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Mobile Hotspot 30GB', monthly_cents: 1500 }),
                makeFeature({ name: 'Mobile Hotspot 30GB', monthly_cents: 1500 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.rule_id).toBe(DUPLICATE_RULE_IDS.within);
    expect(f.affected_account_indexes).toEqual([0]);
    expect(f.affected_line_indexes).toEqual([0]);
    const ev = f.evidence as { same_line: boolean; occurrence_count: number };
    expect(ev.same_line).toBe(true);
    expect(ev.occurrence_count).toBe(2);
  });

  it('fires across-accounts (medium) when two BANs carry an identical feature', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          account_number_last4: '1111',
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'International Plan', monthly_cents: 2000 }),
              ],
            }),
          ],
        }),
        makeAccount({
          account_number_last4: '2222',
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'International Plan', monthly_cents: 2000 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    expect(f.rule_id).toBe(DUPLICATE_RULE_IDS.across);
    expect(f.severity).toBe('medium');
    expect(f.affected_account_indexes.sort()).toEqual([0, 1]);
    // Cross-account findings intentionally leave line indexes empty so
    // translateLineIndexes doesn't wipe them under its single-account
    // invariant.
    expect(f.affected_line_indexes).toEqual([]);
    expect(f.confidence).toBeLessThanOrEqual(0.8);
  });

  it('does NOT fire when the same name has different prices on different lines', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Cloud Storage', monthly_cents: 500 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'Cloud Storage', monthly_cents: 999 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toEqual([]);
  });

  it('does NOT fire on a single occurrence of a feature', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'Unique Feature', monthly_cents: 1234 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toEqual([]);
  });

  it('fires ONCE (not three times) for 3+ occurrences and records the count in evidence', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: 'AppleCare+', monthly_cents: 1099 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'AppleCare+', monthly_cents: 1099 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'AppleCare+', monthly_cents: 1099 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    if (!f) throw new Error('expected finding');
    const ev = f.evidence as { occurrence_count: number };
    expect(ev.occurrence_count).toBe(3);
    // Conservative savings = (count - 1) * monthly. 2 * 1099 = 2198.
    expect(f.estimated_monthly_savings_cents).toBe(2198);
  });

  it('ignores $0 features — duplicating a free feature is no recoverable savings', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [makeFeature({ name: 'Free Promo', monthly_cents: 0 })],
            }),
            makeLine({
              features: [makeFeature({ name: 'Free Promo', monthly_cents: 0 })],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toEqual([]);
  });

  it('normalizes case + whitespace when matching duplicates', () => {
    const bill = makeBill({
      accounts: [
        makeAccount({
          lines: [
            makeLine({
              features: [
                makeFeature({ name: '  AppleCare+  ', monthly_cents: 1099 }),
              ],
            }),
            makeLine({
              features: [
                makeFeature({ name: 'applecare+', monthly_cents: 1099 }),
              ],
            }),
          ],
        }),
      ],
    });
    const findings = detectCrossAuditDuplicates(buildDetectorInput(bill));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule_id).toBe(DUPLICATE_RULE_IDS.within);
  });
});
