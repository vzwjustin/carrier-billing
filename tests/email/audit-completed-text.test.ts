import { describe, expect, it } from 'vitest';

import { renderAuditCompletedText } from '@/lib/email/audit-completed-text';

describe('renderAuditCompletedText', () => {
  const props = {
    auditId: 'audit-123',
    carrierLabel: 'Verizon',
    billingPeriod: '2026-04-01 – 2026-04-30',
    monthlySavingsCents: 4350, // $43.50/mo
    annualSavingsCents: 52200, // $522.00/year
    findingCount: 7,
    highSeverityCount: 2,
    reportUrl: 'https://app.example.com/audits/audit-123',
  };

  it('includes the formatted monthly savings string', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('$43.50/mo');
  });

  it('includes the formatted annual savings string', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('$522.00/year');
  });

  it('includes the report link', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('https://app.example.com/audits/audit-123');
  });

  it('includes the finding count and high-severity count', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('7');
    expect(out).toContain('2 high-severity');
  });

  it('includes the carrier label and billing period', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('Verizon');
    expect(out).toContain('2026-04-01 – 2026-04-30');
  });

  it('includes the unsubscribe placeholder', () => {
    const out = renderAuditCompletedText(props);
    expect(out).toContain('hello@carrieraudit.com');
  });
});
