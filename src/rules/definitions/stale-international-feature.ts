import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'stale_international_feature';

/**
 * L7: roll up into a single per-bill finding rather than emitting one per
 * line. The previous shape produced N findings of $0 savings, inflating the
 * "finding_count" headline metric on the audit summary while saying nothing
 * actionable per finding. One rolled-up finding lists all affected lines as
 * context but only counts once.
 */
export const staleInternationalFeatureRule: Rule = {
  id: RULE_ID,
  title: 'International feature present — verify usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    // TODO(domain): gate on usage history when carriers expose it — when
    // international usage in the period is 0 AND the feature was present in
    // a prior period, upgrade to severity 'low' (or 'medium' for persistent
    // no-usage across multiple periods) and surface real estimated savings.
    type Hit = {
      accountIndex: number;
      lineIndex: number;
      total_cents: number;
      feature_names: string[];
    };
    const hits: Hit[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const intlFeatures = findFeatureByCategory(line, 'international');
        if (intlFeatures.length === 0) return;
        hits.push({
          accountIndex,
          lineIndex,
          total_cents: intlFeatures.reduce(
            (sum, f) => sum + f.monthly_cents,
            0,
          ),
          feature_names: intlFeatures.map((f) => f.name),
        });
      });
    });

    if (hits.length === 0) return [];

    const grandTotal = hits.reduce((sum, h) => sum + h.total_cents, 0);
    // Index sets per-account so the finding can carry every affected line —
    // but emit indexes only for the first account so the per-account index
    // translation contract holds. Other accounts' lines remain visible in
    // the evidence payload.
    const firstAccountIndex = hits[0]?.accountIndex ?? 0;
    const linesInFirstAccount = hits
      .filter((h) => h.accountIndex === firstAccountIndex)
      .map((h) => h.lineIndex);

    const findings: Finding[] = [
      {
        rule_id: RULE_ID,
        severity: 'info',
        title:
          hits.length === 1
            ? 'Verify international add-on is still needed'
            : `Verify ${hits.length} international add-ons are still needed`,
        description: `${hits.length} line${hits.length === 1 ? '' : 's'} on this bill carr${hits.length === 1 ? 'ies' : 'y'} international add-on features totaling ${formatCents(grandTotal)}/mo. Informational only — without usage history we can't tell if it's stale. International add-ons are commonly left enabled long after a one-time trip.`,
        recommended_action:
          'Ask the affected line owners whether they traveled internationally this period. If not, remove the feature and re-add only when a trip is planned.',
        estimated_monthly_savings_cents: 0,
        confidence: 0.6,
        affected_line_indexes: linesInFirstAccount,
        affected_account_indexes: [firstAccountIndex],
        evidence: {
          line_count: hits.length,
          total_monthly_cents: grandTotal,
          per_line: hits.map((h) => ({
            account_index: h.accountIndex,
            line_index: h.lineIndex,
            total_cents: h.total_cents,
            feature_names: h.feature_names,
          })),
        },
      },
    ];

    return findings;
  },
};
