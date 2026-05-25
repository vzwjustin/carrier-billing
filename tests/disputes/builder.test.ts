import { describe, expect, it } from 'vitest';

import {
  buildDisputePacket,
  type DisputeBuilderInput,
} from '@/disputes/builder';

function baseInput(
  overrides: Partial<DisputeBuilderInput> = {},
): DisputeBuilderInput {
  return {
    audit: {
      id: '11111111-1111-4111-8111-111111111111',
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
    },
    finding: {
      id: '22222222-2222-4222-8222-222222222222',
      rule_id: 'expired_promo_credit',
      severity: 'high',
      title: 'Expired promotional credit',
      description:
        'A $25 promotional credit on this account expired last cycle and is no longer being applied.',
      recommended_action:
        'Request reinstatement of the $25 promotional credit for the remaining duration of the original term.',
      estimated_monthly_savings_cents: 2500,
      confidence: 0.92,
      affected_line_ids: ['line-1', 'line-2'],
      affected_account_ids: ['acct-1'],
    },
    lines: [
      { id: 'line-1', mdn_masked: '5551', plan_name: 'Business Unlimited Pro' },
      { id: 'line-2', mdn_masked: '5552', plan_name: 'Business Unlimited Pro' },
    ],
    accounts: [
      {
        id: 'acct-1',
        account_number_masked: '7890',
        account_label: 'Main account',
      },
    ],
    generatedAt: new Date('2026-05-25T00:00:00Z'),
    ...overrides,
  };
}

describe('buildDisputePacket', () => {
  it('shapes the basic packet with formatted carrier, period, and credit', () => {
    const p = buildDisputePacket(baseInput());

    expect(p.carrierName).toBe('Verizon');
    expect(p.carrierSlug).toBe('verizon');
    expect(p.billingPeriodDisplay).toBe('Apr 1, 2026 – Apr 30, 2026');
    expect(p.generatedDateDisplay).toBe('2026-05-25');
    expect(p.auditShortId).toBe('11111111');
    expect(p.findingTitle).toBe('Expired promotional credit');
    expect(p.severityLabel).toBe('High');
    expect(p.ruleId).toBe('expired_promo_credit');
    expect(p.requestedCreditDisplay).toBe('$25.00/mo');
    expect(p.requestedCreditCents).toBe(2500);
    expect(p.requestedCreditAnnualCents).toBe(30000);
    expect(p.confidencePercent).toBe(92);
  });

  it('renders MDNs as last-4 with a leading * (PII discipline)', () => {
    const p = buildDisputePacket(baseInput());
    expect(p.affectedLines).toHaveLength(2);
    expect(p.affectedLines[0]?.mdnDisplay).toBe('*5551');
    expect(p.affectedLines[1]?.mdnDisplay).toBe('*5552');
    // Even if a longer MDN ever slips through, only the last 4 chars are
    // shown — defensive truncation in the formatter.
    const longer = buildDisputePacket(
      baseInput({
        lines: [
          {
            id: 'line-1',
            mdn_masked: '1234567890',
            plan_name: 'X',
          },
        ],
      }),
    );
    expect(longer.affectedLines[0]?.mdnDisplay).toBe('*7890');
  });

  it('renders plan names verbatim and falls back to em-dash when missing', () => {
    const p = buildDisputePacket(
      baseInput({
        lines: [
          { id: 'l1', mdn_masked: '0001', plan_name: null },
          { id: 'l2', mdn_masked: null, plan_name: 'BizPlan' },
        ],
      }),
    );
    expect(p.affectedLines[0]).toEqual({
      mdnDisplay: '*0001',
      planDisplay: '—',
    });
    expect(p.affectedLines[1]).toEqual({
      mdnDisplay: '—',
      planDisplay: 'BizPlan',
    });
  });

  it('formats account number chips as ellipsis + last-4', () => {
    const p = buildDisputePacket(baseInput());
    expect(p.accounts).toHaveLength(1);
    expect(p.accounts[0]?.numberDisplay).toBe('…7890');
    expect(p.accounts[0]?.label).toBe('Main account');
  });

  it('preserves description and recommended_action verbatim', () => {
    const inp = baseInput();
    const p = buildDisputePacket(inp);
    expect(p.description).toBe(inp.finding.description);
    expect(p.recommendedAction).toBe(inp.finding.recommended_action);
  });

  it('builds 4–6 phone script bullets that reference the recommended action', () => {
    const p = buildDisputePacket(baseInput());
    expect(p.phoneScript.length).toBeGreaterThanOrEqual(4);
    expect(p.phoneScript.length).toBeLessThanOrEqual(6);
    // The recommended action should appear inside one of the bullets so
    // the operator's ask is unambiguous on the call.
    expect(p.phoneScript.some((b) => b.includes('reinstatement'))).toBe(true);
    // Carrier name should be present in the opener so the operator
    // doesn't have to recall it themselves.
    expect(p.phoneScript[0]).toContain('Verizon');
  });

  it('handles unknown carrier without throwing or leaking nulls', () => {
    const p = buildDisputePacket(
      baseInput({
        audit: {
          id: '11111111-1111-4111-8111-111111111111',
          carrier: null,
          billing_period_start: null,
          billing_period_end: null,
        },
      }),
    );
    expect(p.carrierName).toBe('Unknown carrier');
    expect(p.carrierSlug).toBe('unknown');
    expect(p.billingPeriodDisplay).toBe('—');
  });

  it('clamps confidence to [0, 100] when the rule emits out-of-band values', () => {
    const tooHigh = buildDisputePacket(
      baseInput({
        finding: { ...baseInput().finding, confidence: 1.5 },
      }),
    );
    const tooLow = buildDisputePacket(
      baseInput({
        finding: { ...baseInput().finding, confidence: -0.2 },
      }),
    );
    expect(tooHigh.confidencePercent).toBe(100);
    expect(tooLow.confidencePercent).toBe(0);
  });

  it('renders empty affected_lines + accounts arrays cleanly', () => {
    const p = buildDisputePacket(
      baseInput({
        finding: {
          ...baseInput().finding,
          affected_line_ids: [],
          affected_account_ids: [],
        },
        lines: [],
        accounts: [],
      }),
    );
    expect(p.affectedLines).toEqual([]);
    expect(p.accounts).toEqual([]);
    // Phone script should degrade gracefully (no "across N lines").
    expect(p.phoneScript[1]).toContain('on my bill');
  });

  it('uses UTC for the generation date so server TZ does not leak in', () => {
    // A Date constructed at 23:00 UTC and 03:00 the next day local should
    // still render as the UTC date.
    const p = buildDisputePacket(
      baseInput({
        generatedAt: new Date('2026-05-25T23:30:00Z'),
      }),
    );
    expect(p.generatedDateDisplay).toBe('2026-05-25');
  });

  it('maps AT&T and T-Mobile slugs to their display names', () => {
    const att = buildDisputePacket(
      baseInput({
        audit: {
          ...baseInput().audit,
          carrier: 'att',
        },
      }),
    );
    const tmo = buildDisputePacket(
      baseInput({
        audit: {
          ...baseInput().audit,
          carrier: 'tmobile',
        },
      }),
    );
    expect(att.carrierName).toBe('AT&T');
    expect(tmo.carrierName).toBe('T-Mobile');
  });
});
