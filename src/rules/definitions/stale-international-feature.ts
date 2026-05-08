import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'stale_international_feature';

export const staleInternationalFeatureRule: Rule = {
  id: RULE_ID,
  title: 'International feature present — verify usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    // TODO(domain): once we have a way to detect international usage on the
    // bill (international minutes / data / TravelPass day-pass charges),
    // raise severity when the feature has gone unused for N months and
    // suppress this finding entirely when the user clearly traveled.
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
          description: `Line carries international add-on(s) (${names}) costing ${formatCents(totalCents)}/mo. We don't currently see usage data on this bill — confirm the user actually traveled this billing period.`,
          recommended_action:
            'Ask the line owner whether they traveled internationally this period. If not, remove the feature and re-add only when a trip is planned.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.5,
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
