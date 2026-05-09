import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'stale_international_feature';

export const staleInternationalFeatureRule: Rule = {
  id: RULE_ID,
  title: 'International feature present — verify usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    // Severity is 'info' (not 'low') and savings is 0: without usage
    // history we cannot tell whether the feature is genuinely stale, so this
    // is a "ask the line owner" prompt rather than a recommended action with
    // dollars attached. Keeping the rule slot reserved so the upgrade path
    // below is incremental rather than a new rule registration.
    // TODO(domain): gate on usage history when carriers expose it — when
    // international usage in the period is 0 AND the feature was present in
    // a prior period, upgrade to severity 'low' (or 'medium' for persistent
    // no-usage across multiple periods) and surface real estimated savings.
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
          severity: 'info',
          title: 'Verify international add-on is still needed',
          description: `This line carries international add-on(s) (${names}) costing ${formatCents(totalCents)}/mo. Informational only — without usage history we can't tell if it's stale. International add-ons are commonly left enabled long after a one-time trip.`,
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
