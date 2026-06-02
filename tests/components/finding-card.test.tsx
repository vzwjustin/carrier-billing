import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FindingCard } from '@/components/report/finding-card';
import type { Finding } from '@/rules/types';

/**
 * Render-shape tests for the FindingCard — the most-rendered component in
 * the report. Three surfaces depend on it:
 *   1. Owner audit page — interactive (status dropdown, bulk-select checkbox)
 *   2. Public share page — read-only (no dropdown, no checkbox)
 *   3. PDF / email — same component, also read-only path
 *
 * The dropdown is dynamically imported (next/dynamic) inside
 * FindingStatusControl so the rendered output may show a placeholder; we
 * stub the control to keep the tests deterministic.
 */

// FindingStatusControl pulls in a 'use client' subtree with next/dynamic.
// Stub it so we can assert presence/absence purely.
vi.mock('@/components/report/finding-status-control', () => ({
  FindingStatusControl: ({ findingId }: { findingId: string }) => (
    <div data-testid="status-control" data-finding-id={findingId}>
      [status control]
    </div>
  ),
}));

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    rule_id: 'orphan_insurance',
    severity: 'medium',
    title: 'Insurance still billing on a suspended line',
    description: 'This line is suspended but is being billed for protection.',
    recommended_action: 'Cancel the protection plan on this line.',
    estimated_monthly_savings_cents: 1500,
    confidence: 0.9,
    affected_line_indexes: [0],
    affected_account_indexes: [0],
    evidence: { feature_name: 'Mobile Protect' },
    status: 'new',
    ...over,
  };
}

describe('FindingCard — owner view', () => {
  it('renders the interactive status control when auditId + finding.id are present and not public', () => {
    const { getByTestId } = render(<FindingCard finding={makeFinding()} auditId="audit-1" />);
    const control = getByTestId('status-control');
    expect(control).toBeInTheDocument();
    expect(control.getAttribute('data-finding-id')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('renders the bulk-select checkbox when the parent opts in via onToggleSelected', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <FindingCard finding={makeFinding()} auditId="audit-1" onToggleSelected={onToggle} />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
  });

  it('does NOT render the checkbox when onToggleSelected is not provided', () => {
    const { container } = render(<FindingCard finding={makeFinding()} auditId="audit-1" />);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe('FindingCard — public share view', () => {
  it('hides the status dropdown when isPublic is true', () => {
    const { queryByTestId } = render(
      <FindingCard finding={makeFinding()} auditId="audit-1" isPublic />,
    );
    expect(queryByTestId('status-control')).toBeNull();
  });

  it('hides the bulk-select checkbox even if onToggleSelected is provided', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <FindingCard
        finding={makeFinding()}
        auditId="audit-1"
        isPublic
        onToggleSelected={onToggle}
      />,
    );
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('hides the dropdown when finding.id is missing (pre-persisted)', () => {
    const { queryByTestId } = render(
      <FindingCard finding={makeFinding({ id: undefined })} auditId="audit-1" />,
    );
    expect(queryByTestId('status-control')).toBeNull();
  });
});

describe('FindingCard — copy + badges', () => {
  it('shows title, description, and recommended_action verbatim', () => {
    const { container } = render(<FindingCard finding={makeFinding()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Insurance still billing on a suspended line');
    expect(text).toContain('This line is suspended');
    expect(text).toContain('Cancel the protection plan');
  });

  it('shows the rule_id badge', () => {
    const { container } = render(<FindingCard finding={makeFinding()} />);
    expect(container.textContent).toContain('orphan_insurance');
  });

  it('shows the savings block only when estimated_monthly_savings_cents > 0', () => {
    const withSavings = render(<FindingCard finding={makeFinding()} />);
    expect(withSavings.container.textContent).toContain('Estimated savings');
    expect(withSavings.container.textContent).toContain('15.00');
    expect(withSavings.container.textContent).toContain('/ month');

    const noSavings = render(
      <FindingCard finding={makeFinding({ estimated_monthly_savings_cents: 0 })} />,
    );
    expect(noSavings.container.textContent).not.toContain('Estimated savings');
  });

  it('pluralizes "line" / "account" counts correctly', () => {
    const single = render(<FindingCard finding={makeFinding({ affected_line_indexes: [0] })} />);
    expect(single.container.textContent).toContain('Affects 1 line');
    expect(single.container.textContent).not.toContain('Affects 1 lines');

    const plural = render(
      <FindingCard finding={makeFinding({ affected_line_indexes: [0, 1, 2] })} />,
    );
    expect(plural.container.textContent).toContain('Affects 3 lines');
  });

  it('defaults status to "new" when finding.status is unset', () => {
    const { container } = render(<FindingCard finding={makeFinding({ status: undefined })} />);
    // FINDING_STATUS_LABEL.new = "New" — check the badge appears.
    expect(container.textContent).toContain('New');
  });
});

describe('FindingCard — selection visual state', () => {
  it('applies the "selected" ring class when selected=true', () => {
    const { container } = render(
      <FindingCard finding={makeFinding()} auditId="audit-1" selected onToggleSelected={vi.fn()} />,
    );
    const article = container.querySelector('article');
    expect(article?.className).toContain('ring-1');
    expect(article?.className).toContain('border-neutral-900');
  });

  it('does NOT apply the ring class when selected=false', () => {
    const { container } = render(
      <FindingCard finding={makeFinding()} auditId="audit-1" onToggleSelected={vi.fn()} />,
    );
    const article = container.querySelector('article');
    expect(article?.className).not.toContain('ring-1');
  });
});
