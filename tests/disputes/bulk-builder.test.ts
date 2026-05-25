import { describe, expect, it } from 'vitest';

import {
  buildBulkDisputeLetter,
  type BulkDisputeBuilderInput,
  type BulkDisputeFindingInput,
} from '@/disputes/bulk-builder';
import type { DisputeFindingInput } from '@/disputes/builder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUDIT_ID = '11111111-1111-4111-8111-111111111111';

function makeFinding(
  rule_id: string,
  monthly_cents: number,
  overrides: Partial<DisputeFindingInput> = {},
): DisputeFindingInput {
  return {
    id: `${rule_id}-id`,
    rule_id,
    severity: 'high',
    title: `Finding for ${rule_id}`,
    description: `A short description for ${rule_id}.`,
    recommended_action: `Take action on ${rule_id}.`,
    estimated_monthly_savings_cents: monthly_cents,
    confidence: 0.9,
    affected_line_ids: [],
    affected_account_ids: [],
    ...overrides,
  };
}

function makeEntry(
  rule_id: string,
  monthly_cents: number,
  opts: {
    lines?: BulkDisputeFindingInput['lines'];
    accounts?: BulkDisputeFindingInput['accounts'];
    findingOverrides?: Partial<DisputeFindingInput>;
  } = {},
): BulkDisputeFindingInput {
  return {
    finding: makeFinding(rule_id, monthly_cents, opts.findingOverrides),
    lines: opts.lines ?? [],
    accounts: opts.accounts ?? [],
  };
}

function baseInput(
  overrides: Partial<BulkDisputeBuilderInput> = {},
): BulkDisputeBuilderInput {
  return {
    audit: {
      id: AUDIT_ID,
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
    },
    operatorName: 'Jamie Operator',
    findings: [],
    generatedAt: new Date('2026-05-25T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildBulkDisputeLetter', () => {
  it('returns an empty letter when no findings are supplied', () => {
    const letter = buildBulkDisputeLetter(baseInput());
    expect(letter.items).toEqual([]);
    expect(letter.totalRequestedCreditCents).toBe(0);
    expect(letter.totalRequestedCreditAnnualCents).toBe(0);
    expect(letter.totalRequestedCreditDisplay).toBe('$0.00/mo');
    expect(letter.totalRequestedCreditAnnualDisplay).toBe('$0.00');
    expect(letter.carrierName).toBe('Verizon');
    expect(letter.billingPeriodDisplay).toBe('Apr 1, 2026 – Apr 30, 2026');
    expect(letter.auditShortId).toBe('11111111');
    expect(letter.generatedDateDisplay).toBe('2026-05-25');
    expect(letter.generatedDateLong).toBe('May 25, 2026');
    // Closing block always renders with the operator name on the last line.
    expect(letter.closingBlock.at(-1)).toBe('Jamie Operator');
  });

  it('builds a single-finding letter with masked MDN, account, and totals', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        findings: [
          makeEntry('expired_promo_credit', 2500, {
            lines: [
              { id: 'l1', mdn_masked: '5551', plan_name: 'BizPlan' },
            ],
            accounts: [
              {
                id: 'a1',
                account_number_masked: '7890',
                account_label: 'Main',
              },
            ],
          }),
        ],
      }),
    );

    expect(letter.items).toHaveLength(1);
    const item = letter.items[0];
    expect(item).toBeDefined();
    expect(item?.itemNumber).toBe(1);
    expect(item?.requestedCreditCents).toBe(2500);
    expect(item?.requestedCreditDisplay).toBe('$25.00/mo');
    // MDNs are last-4 with leading * (PII discipline).
    expect(item?.affectedMdns).toEqual(['*5551']);
    // Accounts include label + last-4 chip.
    expect(item?.affectedAccounts).toEqual(['Main (…7890)']);

    expect(letter.totalRequestedCreditCents).toBe(2500);
    expect(letter.totalRequestedCreditDisplay).toBe('$25.00/mo');
    expect(letter.totalRequestedCreditAnnualCents).toBe(30000);
    expect(letter.totalRequestedCreditAnnualDisplay).toBe('$300.00');
  });

  it('sums five findings into the total and preserves their order', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        findings: [
          makeEntry('rule_a', 1000),
          makeEntry('rule_b', 1500),
          makeEntry('rule_c', 2500),
          makeEntry('rule_d', 750),
          makeEntry('rule_e', 12500),
        ],
      }),
    );

    expect(letter.items).toHaveLength(5);
    // Item numbers are 1-based and follow input order.
    expect(letter.items.map((i) => i.itemNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(letter.items.map((i) => i.ruleId)).toEqual([
      'rule_a',
      'rule_b',
      'rule_c',
      'rule_d',
      'rule_e',
    ]);
    expect(letter.totalRequestedCreditCents).toBe(
      1000 + 1500 + 2500 + 750 + 12500,
    );
    expect(letter.totalRequestedCreditDisplay).toBe('$182.50/mo');
    expect(letter.totalRequestedCreditAnnualCents).toBe(18250 * 12);
    expect(letter.totalRequestedCreditAnnualDisplay).toBe('$2,190.00');
  });

  it('renders missing affected lines / accounts as empty arrays (no nulls)', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        findings: [
          // Finding references lines/accounts that the caller did NOT join in.
          // The builder doesn't fabricate placeholders — it just renders the
          // empty arrays it was given.
          makeEntry('orphan_rule', 500, {
            findingOverrides: {
              affected_line_ids: ['missing'],
              affected_account_ids: ['missing'],
            },
            // No lines / accounts joined in.
          }),
        ],
      }),
    );
    const item = letter.items[0];
    expect(item?.affectedMdns).toEqual([]);
    expect(item?.affectedAccounts).toEqual([]);
  });

  it('falls back to "Operator" when the profile name is null or blank', () => {
    const blank = buildBulkDisputeLetter(
      baseInput({ operatorName: '   ', findings: [makeEntry('r', 100)] }),
    );
    const nullish = buildBulkDisputeLetter(
      baseInput({ operatorName: null, findings: [makeEntry('r', 100)] }),
    );

    expect(blank.operatorName).toBe('Operator');
    expect(blank.closingBlock.at(-1)).toBe('Operator');
    expect(nullish.operatorName).toBe('Operator');
    expect(nullish.closingBlock.at(-1)).toBe('Operator');
  });

  it('trims whitespace around a real operator name', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        operatorName: '  Pat Lee  ',
        findings: [makeEntry('r', 100)],
      }),
    );
    expect(letter.operatorName).toBe('Pat Lee');
  });

  it('maps unknown carriers to a stable fallback display name', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        audit: {
          id: AUDIT_ID,
          carrier: null,
          billing_period_start: null,
          billing_period_end: null,
        },
      }),
    );
    expect(letter.carrierName).toBe('Unknown carrier');
    expect(letter.carrierSlug).toBe('unknown');
    expect(letter.billingPeriodDisplay).toBe('—');
  });

  it('renders the generation date as UTC ISO (no TZ leakage)', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({ generatedAt: new Date('2026-05-25T23:30:00Z') }),
    );
    expect(letter.generatedDateDisplay).toBe('2026-05-25');
    expect(letter.generatedDateLong).toBe('May 25, 2026');
  });

  it('passes severity label through verbatim per item', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        findings: [
          makeEntry('high_rule', 100, { findingOverrides: { severity: 'high' } }),
          makeEntry('med_rule', 200, {
            findingOverrides: { severity: 'medium' },
          }),
          makeEntry('low_rule', 300, { findingOverrides: { severity: 'low' } }),
          makeEntry('info_rule', 400, {
            findingOverrides: { severity: 'info' },
          }),
        ],
      }),
    );
    expect(letter.items.map((i) => i.severityLabel)).toEqual([
      'High',
      'Medium',
      'Low',
      'Info',
    ]);
  });

  it('defensively truncates long MDN strings to last-4 (PII safety net)', () => {
    const letter = buildBulkDisputeLetter(
      baseInput({
        findings: [
          makeEntry('rule', 100, {
            lines: [{ id: 'l1', mdn_masked: '5551234567', plan_name: 'P' }],
          }),
        ],
      }),
    );
    expect(letter.items[0]?.affectedMdns).toEqual(['*4567']);
  });
});
