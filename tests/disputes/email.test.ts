import { describe, expect, it } from 'vitest';

import { buildDisputePacket, type DisputeBuilderInput } from '@/disputes/builder';
import { buildDisputeEml, buildDisputeEmail } from '@/disputes/email';

function packetFromBaseline(overrides: Partial<DisputeBuilderInput> = {}) {
  const input: DisputeBuilderInput = {
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
      affected_line_ids: ['line-1'],
      affected_account_ids: ['acct-1'],
    },
    lines: [
      {
        id: 'line-1',
        mdn_masked: '5551',
        plan_name: 'Business Unlimited Pro',
      },
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
  return buildDisputePacket(input);
}

describe('buildDisputeEmail', () => {
  it('produces a non-empty subject + body with finding title and carrier', () => {
    const packet = packetFromBaseline();
    const { subject, body } = buildDisputeEmail(packet);

    expect(subject).toContain('Expired promotional credit');
    expect(subject).toContain('Verizon');
    expect(subject).toContain('Apr 1, 2026 – Apr 30, 2026');

    expect(body).toContain('Verizon');
    expect(body).toContain('Issue: Expired promotional credit');
    expect(body).toContain('Severity: High');
    expect(body).toContain('Requested credit: $25.00/mo');
    expect(body).toContain('Estimated annual impact if uncorrected: $300.00');
  });

  it('keeps masked MDNs in the lines section and never raw phone numbers', () => {
    const packet = packetFromBaseline();
    const { body } = buildDisputeEmail(packet);
    expect(body).toContain('*5551');
    // A plausible "raw" form a leaky implementation might emit.
    expect(body).not.toContain('15555555551');
    // Plan name passes through verbatim.
    expect(body).toContain('Business Unlimited Pro');
  });

  it('includes the audit short id + rule id + generation date as a reference line', () => {
    const packet = packetFromBaseline();
    const { body } = buildDisputeEmail(packet);
    expect(body).toContain('CarrierAudit packet 11111111');
    expect(body).toContain('rule expired_promo_credit');
    expect(body).toContain('generated 2026-05-25');
  });

  it('uses verbatim description and recommended_action paragraphs', () => {
    const packet = packetFromBaseline();
    const { body } = buildDisputeEmail(packet);
    expect(body).toContain(packet.description);
    expect(body).toContain(packet.recommendedAction);
  });

  it('degrades gracefully when no accounts or lines are specified', () => {
    const packet = packetFromBaseline({
      finding: {
        id: '22222222-2222-4222-8222-222222222222',
        rule_id: 'orphan_insurance',
        severity: 'medium',
        title: 'Orphan insurance',
        description: 'Insurance on a suspended line.',
        recommended_action: 'Remove insurance.',
        estimated_monthly_savings_cents: 1500,
        confidence: 0.7,
        affected_line_ids: [],
        affected_account_ids: [],
      },
      lines: [],
      accounts: [],
    });
    const { body } = buildDisputeEmail(packet);
    expect(body).toContain('(account not specified)');
    expect(body).toContain('(none specified)');
  });
});

describe('buildDisputeEml', () => {
  it('emits a Subject header, blank line, and body in RFC 822 shape', () => {
    const packet = packetFromBaseline();
    const eml = buildDisputeEml(packet);
    const lines = eml.split('\r\n');

    expect(lines[0]?.startsWith('Subject: ')).toBe(true);
    expect(lines).toContain('MIME-Version: 1.0');
    expect(lines).toContain('Content-Type: text/plain; charset=utf-8');
    // First blank line marks the end of headers.
    const blankIdx = lines.indexOf('');
    expect(blankIdx).toBeGreaterThan(0);
    // Body should appear after the blank line.
    const bodyStart = lines.slice(blankIdx + 1).join('\r\n');
    expect(bodyStart.length).toBeGreaterThan(0);
    expect(bodyStart).toContain('Verizon');
  });

  it('uses CRLF line endings throughout', () => {
    const packet = packetFromBaseline();
    const eml = buildDisputeEml(packet);
    // No bare-LF lines anywhere (RFC 5322 §2.3).
    const bareLfMatches = eml.match(/(?<!\r)\n/g);
    expect(bareLfMatches).toBeNull();
  });

  it('embeds the audit short id + rule id as an X- header for traceability', () => {
    const packet = packetFromBaseline();
    const eml = buildDisputeEml(packet);
    expect(eml).toContain(`X-CarrierAudit-Packet: ${packet.auditShortId}/${packet.ruleId}`);
  });
});
