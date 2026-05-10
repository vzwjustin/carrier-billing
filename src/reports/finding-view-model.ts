/**
 * Pure data shaper that maps a `Finding` (the rules engine's output shape)
 * to the display fields both the web and PDF report renderers consume.
 *
 * Both `src/components/report/finding-card.tsx` (react-dom) and
 * `src/reports/pdf/finding-card.tsx` (react-pdf) call `buildFindingViewModel`
 * so the field set stays in lockstep across surfaces. The renderers stay
 * separate (different React renderers) but the data layer is shared.
 *
 * No JSX, no React imports — keep this pure.
 */
import type { Finding, Severity } from '@/rules/types';

export interface FindingViewModel {
  ruleId: string;
  title: string;
  description: string;
  recommendedAction: string;
  severity: Severity;
  /** Capitalized severity for badge text — "High" / "Medium" / "Low" / "Info". */
  severityLabel: string;
  /** Raw 0..1 confidence as supplied by the rule. */
  confidence: number;
  /** Integer 0..100 derived from `confidence`, clamped. */
  confidencePercent: number;
  /** Human label for confidence — "Speculative" / "Likely" / "High confidence". */
  confidenceLabel: string;
  /** Signed integer cents — preserve the rules-engine money discipline. */
  monthlySavingsCents: number;
  /** True when `monthlySavingsCents > 0` (renderers may hide the savings block). */
  hasSavings: boolean;
  /** Count of distinct lines the finding affects. */
  affectedLineCount: number;
  /** Count of distinct accounts the finding affects. */
  affectedAccountCount: number;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export function severityLabel(s: Severity): string {
  return SEVERITY_LABEL[s];
}

export function confidencePercent(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return Math.round(clamped * 100);
}

export function confidenceLabel(c: number): string {
  if (c < 0.5) return 'Speculative';
  if (c <= 0.8) return 'Likely';
  return 'High confidence';
}

export function buildFindingViewModel(finding: Finding): FindingViewModel {
  const monthly = finding.estimated_monthly_savings_cents;
  return {
    ruleId: finding.rule_id,
    title: finding.title,
    description: finding.description,
    recommendedAction: finding.recommended_action,
    severity: finding.severity,
    severityLabel: severityLabel(finding.severity),
    confidence: finding.confidence,
    confidencePercent: confidencePercent(finding.confidence),
    confidenceLabel: confidenceLabel(finding.confidence),
    monthlySavingsCents: monthly,
    hasSavings: monthly > 0,
    affectedLineCount: finding.affected_line_indexes.length,
    affectedAccountCount: finding.affected_account_indexes.length,
  };
}
