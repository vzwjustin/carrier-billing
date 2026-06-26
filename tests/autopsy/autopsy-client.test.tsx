import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AutopsyClient, type AutopsyClientProps } from '@/components/autopsy/autopsy-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function makeProps(): AutopsyClientProps {
  return {
    audit: {
      id: 'audit-current',
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 12_000,
      original_filename: 'current.pdf',
    },
    candidates: [],
    existing: {
      id: 'comparison-1',
      previous_audit_id: 'audit-previous',
      current_audit_id: 'audit-current',
      previous_total_cents: 10_000,
      current_total_cents: 12_000,
      net_change_cents: 2_000,
      percent_change_bps: 2_000,
      disputable_cents: 0,
      optimization_cents: 0,
      unexplained_cents: 0,
      executive_summary: 'Bill increased.',
      created_at: '2026-05-01T00:00:00Z',
    },
    drivers: [
      {
        id: 'driver-1',
        category: 'plan_changes',
        title: 'Plan changes',
        summary: 'Two lines changed.',
        previous_cents: 10_000,
        current_cents: 12_000,
        difference_cents: 2_000,
        affected_lines_count: 2,
        confidence: 0.9,
        is_disputable: false,
        is_optimization: false,
        is_unexplained: false,
        recommended_action: null,
        evidence: {
          lines: [
            {
              account_last4: '1234',
              mdn_last4: '1111',
              user_label: 'Jane Doe',
              previous_cents: 5_000,
              current_cents: 6_000,
              difference_cents: 1_000,
            },
            {
              account_last4: '1234',
              mdn_last4: '2222',
              user_label: 'Router',
              previous_cents: 5_000,
              current_cents: 6_000,
              difference_cents: 1_000,
            },
          ],
        },
      },
    ],
  };
}

describe('AutopsyClient', () => {
  it('does not render stale subscriber names from driver evidence', () => {
    const { container, getByRole } = render(<AutopsyClient {...makeProps()} />);

    fireEvent.click(getByRole('button', { name: /plan changes/i }));

    const text = container.textContent ?? '';
    expect(text).not.toContain('Jane Doe');
    expect(text).toContain('Router');
  });
});
