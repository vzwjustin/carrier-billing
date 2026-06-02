import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SavingsHero } from '@/components/report/savings-hero';
import type { ReportAudit } from '@/reports/types';

/**
 * Render-shape tests for the SavingsHero block. This component renders in
 * both the web report and the PDF email-link landing, so a regression in
 * styling or copy would land everywhere at once.
 *
 * The component picks between an "emerald/positive" theme when monthly
 * savings > 0 and a neutral theme when zero. It also derives annual from
 * monthly × 12 when the persisted annual value is non-positive.
 */

function makeAudit(over: Partial<ReportAudit> = {}): ReportAudit {
  return {
    id: 'audit-1',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 100000,
    account_count: 1,
    line_count: 10,
    finding_count: 5,
    high_severity_count: 2,
    estimated_monthly_savings_cents: 8500,
    estimated_annual_savings_cents: 102000,
    completed_at: '2026-05-01T00:00:00Z',
    extraction_confidence: 'high',
    ...over,
  };
}

describe('SavingsHero — positive savings (emerald theme)', () => {
  it('renders monthly + annual dollars + counts', () => {
    const { container } = render(<SavingsHero audit={makeAudit()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Estimated savings');
    expect(text).toContain('per month');
    expect(text).toContain('per year');
    // formatCents — defaults to "$X.YY" or similar.
    expect(text).toContain('85.00');
    expect(text).toContain('1,020.00');
    // Finding counts surfaced.
    expect(text).toContain('Findings');
    expect(text).toContain('5');
    expect(text).toContain('High severity');
    expect(text).toContain('2');
  });

  it('uses the emerald-themed section when monthly savings are positive', () => {
    const { container } = render(<SavingsHero audit={makeAudit()} />);
    const section = container.querySelector('section');
    expect(section?.className).toContain('emerald');
  });

  it('uses the red tone for High severity when high_severity_count > 0', () => {
    const { container } = render(
      <SavingsHero
        audit={makeAudit({ high_severity_count: 3 })}
      />,
    );
    // Find the High severity stat block — it has tone-red classes.
    const html = container.innerHTML;
    // The stat block uses 'text-red-700' for the label tone when count > 0.
    expect(html).toContain('text-red-700');
  });
});

describe('SavingsHero — zero savings (neutral theme)', () => {
  it('uses the neutral theme when monthly savings is 0', () => {
    const { container } = render(
      <SavingsHero
        audit={makeAudit({
          estimated_monthly_savings_cents: 0,
          estimated_annual_savings_cents: 0,
        })}
      />,
    );
    const section = container.querySelector('section');
    expect(section?.className).toContain('neutral');
    expect(section?.className).not.toContain('emerald');
  });

  it('does NOT use the red tone for High severity when there are no high findings', () => {
    const { container } = render(
      <SavingsHero
        audit={makeAudit({
          estimated_monthly_savings_cents: 0,
          high_severity_count: 0,
        })}
      />,
    );
    // No red — falls back to neutral tone.
    expect(container.innerHTML).not.toContain('text-red-700');
  });
});

describe('SavingsHero — annual fallback', () => {
  it('derives annual from monthly × 12 when persisted annual is non-positive', () => {
    const { container } = render(
      <SavingsHero
        audit={makeAudit({
          estimated_monthly_savings_cents: 5000,
          estimated_annual_savings_cents: 0,
        })}
      />,
    );
    const text = container.textContent ?? '';
    // 5000 × 12 = 60000 cents → $600.00
    expect(text).toContain('600.00');
  });

  it('uses persisted annual when it is positive (even if not exactly monthly × 12)', () => {
    const { container } = render(
      <SavingsHero
        audit={makeAudit({
          estimated_monthly_savings_cents: 5000,
          estimated_annual_savings_cents: 100000, // not 5000 × 12; use as-is
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('1,000.00');
  });
});

describe('SavingsHero — accessibility', () => {
  it('exposes a stable aria-label on the outer section', () => {
    const { container } = render(<SavingsHero audit={makeAudit()} />);
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe(
      'Estimated savings summary',
    );
  });
});
