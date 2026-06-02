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
          total_cents: intlFeatures.reduce((sum, f) => sum + f.monthly_cents, 0),
          feature_names: intlFeatures.map((f) => f.name),
        });
      });
    });

    if (hits.length === 0) return [];

    // M2: emit ONE finding per account so multi-account bills don't lose
    // line linkage on accounts ≥ 1. The previous shape squashed all hits
    // into a single finding scoped to the first account, leaving lines in
    // other accounts visible in `evidence.per_line` but unlinked to UUIDs
    // (no chip in the report UI/PDF).
    //
    // Group hits by account; emit one finding per group. The per-finding
    // contract still holds: each finding's `affected_line_indexes` are
    // local to its sole `affected_account_indexes[0]`.
    const byAccount = new Map<number, Hit[]>();
    for (const hit of hits) {
      const bucket = byAccount.get(hit.accountIndex);
      if (bucket) {
        bucket.push(hit);
      } else {
        byAccount.set(hit.accountIndex, [hit]);
      }
    }

    const findings: Finding[] = [];
    for (const [accountIndex, accountHits] of byAccount) {
      const accountTotal = accountHits.reduce((sum, h) => sum + h.total_cents, 0);
      const lineIndexes = accountHits.map((h) => h.lineIndex);
      const linePlural = accountHits.length === 1 ? '' : 's';
      const carries = accountHits.length === 1 ? 'ies' : 'y';
      findings.push({
        rule_id: RULE_ID,
        severity: 'info',
        title:
          accountHits.length === 1
            ? 'Verify international add-on is still needed'
            : `Verify ${accountHits.length} international add-ons are still needed`,
        description: `${accountHits.length} line${linePlural} on this account carr${carries} international add-on features totaling ${formatCents(accountTotal)}/mo. Informational only — without usage history we can't tell if it's stale. International add-ons are commonly left enabled long after a one-time trip.`,
        recommended_action:
          'Ask the affected line owners whether they traveled internationally this period. If not, remove the feature and re-add only when a trip is planned.',
        estimated_monthly_savings_cents: 0,
        confidence: 0.6,
        affected_line_indexes: lineIndexes,
        affected_account_indexes: [accountIndex],
        evidence: {
          line_count: accountHits.length,
          total_monthly_cents: accountTotal,
          per_line: accountHits.map((h) => ({
            account_index: h.accountIndex,
            line_index: h.lineIndex,
            total_cents: h.total_cents,
            feature_names: h.feature_names,
          })),
        },
      });
    }

    return findings;
  },
};
