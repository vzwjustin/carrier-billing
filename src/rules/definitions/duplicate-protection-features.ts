import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'duplicate_protection_features';

export const duplicateProtectionFeaturesRule: Rule = {
  id: RULE_ID,
  title: 'Multiple insurance/protection features on the same line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const insurance = findFeatureByCategory(line, 'insurance');
        if (insurance.length <= 1) return;

        const sortedAsc = [...insurance].sort(
          (a, b) => a.monthly_cents - b.monthly_cents,
        );
        const total = sortedAsc.reduce((sum, f) => sum + f.monthly_cents, 0);
        // Keep the cheapest; savings = drop everything else.
        const cheapest = sortedAsc[0];
        const cheapestCents = cheapest === undefined ? 0 : cheapest.monthly_cents;
        const savings = total - cheapestCents;

        const names = insurance.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Line carries ${insurance.length} overlapping protection features`,
          description: `This line has multiple protection/insurance features (${names}) totaling ${formatCents(total)}/mo. Carrier protection plans generally don't stack — keeping more than one is almost always waste.`,
          recommended_action:
            'Pick the single best plan (typically the most comprehensive at the lowest cost) and drop the others.',
          estimated_monthly_savings_cents: savings,
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            features: insurance.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            total_monthly_cents: total,
            cheapest_monthly_cents: cheapestCents,
          },
        });
      });
    });

    return findings;
  },
};
