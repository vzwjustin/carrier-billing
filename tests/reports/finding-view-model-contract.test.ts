/**
 * Contract test for the shared `FindingViewModel`.
 *
 * Drift guard: the web report (`src/components/report/finding-card.tsx`) and
 * the PDF report (`src/reports/pdf/finding-card.tsx`) both consume
 * `buildFindingViewModel`. This test asserts:
 *   1. The view-model exposes every public field with the expected shape.
 *   2. The web FindingCard renders every field that's user-visible on web.
 *   3. The PDF FindingCard renders every field that's user-visible on PDF.
 *
 * If a field is added to the view-model but only one renderer reads it,
 * the corresponding "renders X" assertion below will catch the drift.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { Finding } from '@/rules/types';
import {
  buildFindingViewModel,
  type FindingViewModel,
} from '@/reports/finding-view-model';
import { FindingCard as WebFindingCard } from '@/components/report/finding-card';
import { FindingCard as PdfFindingCard } from '@/reports/pdf/finding-card';

const FIXTURE: Finding = {
  rule_id: 'expired_promo_credit',
  severity: 'high',
  title: 'Expired promotional credit still on bill',
  description:
    'A $25/month promotional credit appears to have expired but is still being applied — likely to fall off next cycle.',
  recommended_action:
    'Call carrier and request a one-time credit for the prior expired month.',
  estimated_monthly_savings_cents: 2500,
  confidence: 0.9,
  affected_line_indexes: [0, 2, 4],
  affected_account_indexes: [0, 1],
  evidence: { source: 'test' },
};

// ---------------------------------------------------------------------------
// React-element tree walker for the PDF renderer.
//
// @react-pdf/renderer primitives (Page/View/Text) are class components that
// render to a PDF canvas; for tree walking we just descend into props.children.
// Our own pure function components (FindingCard, SeverityBadge) are invoked
// directly so their props (e.g. the `label` prop on SeverityBadge) are
// reachable. Both styles compose correctly in this collector.
// ---------------------------------------------------------------------------

type AnyChild = React.ReactNode | React.ReactNode[];

function isFunctionComponent(
  type: unknown,
): type is (props: Record<string, unknown>) => React.ReactNode {
  return (
    typeof type === 'function' &&
    !(type as { prototype?: { isReactComponent?: unknown } }).prototype
      ?.isReactComponent
  );
}

function collectText(node: AnyChild): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'type' in node && 'props' in node) {
    const el = node as React.ReactElement<{ children?: AnyChild }>;
    if (isFunctionComponent(el.type)) {
      return collectText(
        el.type(el.props as unknown as Record<string, unknown>),
      );
    }
    return collectText(el.props.children);
  }
  return '';
}

describe('FindingViewModel contract', () => {
  const vm: FindingViewModel = buildFindingViewModel(FIXTURE);

  it('exposes every public field with the documented shape', () => {
    expect(vm).toEqual({
      ruleId: 'expired_promo_credit',
      title: FIXTURE.title,
      description: FIXTURE.description,
      recommendedAction: FIXTURE.recommended_action,
      severity: 'high',
      severityLabel: 'High',
      confidence: 0.9,
      confidencePercent: 90,
      confidenceLabel: 'High confidence',
      monthlySavingsCents: 2500,
      hasSavings: true,
      affectedLineCount: 3,
      affectedAccountCount: 2,
    });
  });

  it('clamps and rounds the confidence percent to an integer in [0, 100]', () => {
    expect(buildFindingViewModel({ ...FIXTURE, confidence: -0.2 }).confidencePercent).toBe(0);
    expect(buildFindingViewModel({ ...FIXTURE, confidence: 1.5 }).confidencePercent).toBe(100);
    expect(buildFindingViewModel({ ...FIXTURE, confidence: 0.555 }).confidencePercent).toBe(56);
  });

  it('classifies confidence labels by band', () => {
    expect(buildFindingViewModel({ ...FIXTURE, confidence: 0.4 }).confidenceLabel).toBe('Speculative');
    expect(buildFindingViewModel({ ...FIXTURE, confidence: 0.7 }).confidenceLabel).toBe('Likely');
    expect(buildFindingViewModel({ ...FIXTURE, confidence: 0.9 }).confidenceLabel).toBe('High confidence');
  });

  it('marks hasSavings false when monthly savings is zero', () => {
    const zero = buildFindingViewModel({
      ...FIXTURE,
      estimated_monthly_savings_cents: 0,
    });
    expect(zero.hasSavings).toBe(false);
    expect(zero.monthlySavingsCents).toBe(0);
  });
});

describe('Web FindingCard renders every shared view-model field', () => {
  it('renders title, description, recommended action, ruleId, severity, confidence, savings, affected counts', () => {
    render(React.createElement(WebFindingCard, { finding: FIXTURE }));
    const vm = buildFindingViewModel(FIXTURE);

    // Text fields
    expect(screen.getByText(vm.title)).toBeInTheDocument();
    expect(screen.getByText(vm.description)).toBeInTheDocument();
    expect(screen.getByText(vm.recommendedAction)).toBeInTheDocument();

    // Severity + confidence labels
    expect(screen.getByText(vm.severityLabel)).toBeInTheDocument();
    expect(screen.getByText(vm.confidenceLabel)).toBeInTheDocument();

    // Rule id chip
    expect(screen.getByText(vm.ruleId)).toBeInTheDocument();

    // Affected line + account chips
    expect(
      screen.getByText(`Affects ${vm.affectedLineCount} lines`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${vm.affectedAccountCount} accounts affected`),
    ).toBeInTheDocument();

    // Savings — formatted as US dollars from cents.
    expect(screen.getByText('$25.00')).toBeInTheDocument();
  });
});

describe('PDF FindingCard renders every shared view-model field', () => {
  it('references title, description, recommended action, ruleId, severity, confidence percent, savings, affected counts', () => {
    const tree = PdfFindingCard({ finding: FIXTURE });
    const text = collectText(tree);
    const vm = buildFindingViewModel(FIXTURE);

    expect(text).toContain(vm.title);
    expect(text).toContain(vm.description);
    expect(text).toContain(vm.recommendedAction);
    expect(text).toContain(vm.ruleId);
    expect(text).toContain(vm.severityLabel);

    // PDF shows confidence as percent, not the label.
    expect(text).toContain(`${vm.confidencePercent}%`);

    // PDF always shows savings, formatted with /mo suffix.
    expect(text).toContain('$25.00/mo');

    // Affected counts.
    expect(text).toContain(`${vm.affectedLineCount} lines affected`);
    expect(text).toContain(`${vm.affectedAccountCount} accounts affected`);
  });
});
