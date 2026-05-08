import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'stale_international_feature';

export const staleInternationalFeatureRule: Rule = {
  id: RULE_ID,
  title: 'International feature present — verify usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    // TODO(domain): once usage history is available, suppress when
    // international usage > 0 in the period.
    // TODO(future): when we have multi-period history (cross-bill state),
    // we can check whether the international feature was present BEFORE the
    // current period and still went unused — that lets us upgrade severity
    // to 'medium' for the persistent-no-usage case.
    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const intlFeatures = findFeatureByCategory(line, 'international');
        if (intlFeatures.length === 0) return;

        const totalCents = intlFeatures.reduce(
          (sum, f) => sum + f.monthly_cents,
          0,
        );
        const names = intlFeatures.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: 'Verify international add-on is still needed',
          description: `This line carries international add-on(s) (${names}) costing ${formatCents(totalCents)}/mo. This is flagged for review only — we don't have usage history yet to confirm whether it's stale. International add-ons are commonly left enabled long after a one-time trip.`,
          recommended_action:
            'Ask the line owner whether they traveled internationally this period. If not, remove the feature and re-add only when a trip is planned.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.6,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            international_features: intlFeatures.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
          },
        });
      });
    });

    return findings;
  },
};
