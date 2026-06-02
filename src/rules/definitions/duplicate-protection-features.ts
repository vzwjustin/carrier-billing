import type { Rule, Finding } from '../types';
import { categorizeFeatureSet, formatCents } from '../helpers';

const RULE_ID = 'duplicate_protection_features';

/**
 * One finding per LINE (not per feature). Evidence carries the full list of
 * overlapping insurance feature names so the UI can render them. We
 * deduplicate by category so two `insurance` entries roll up into a single
 * finding rather than firing once per feature.
 */
export const duplicateProtectionFeaturesRule: Rule = {
  id: RULE_ID,
  title: 'Multiple insurance/protection features on the same line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const grouped = categorizeFeatureSet(line.features);
        // Only paid insurance features can overlap into waste. Two $0 (bundled/
        // free) entries would compute savings = total - mostExpensive = 0 and
        // fire a spurious "$0 savings" finding card. Filter them out the same
        // way duplicates/detect.ts does before deciding whether a stack exists.
        const insurance = grouped.insurance.filter((f) => f.monthly_cents > 0);
        if (insurance.length <= 1) return;

        const sortedAsc = [...insurance].sort(
          (a, b) => a.monthly_cents - b.monthly_cents,
        );
        const total = sortedAsc.reduce((sum, f) => sum + f.monthly_cents, 0);
        // M6: conservative savings model — assume the customer keeps the MOST
        // expensive (typically most comprehensive) coverage and drops the
        // others. Previous "keep the cheapest" math overestimated savings by
        // up to 6.5× on realistic Asurion-vs-WPP stacks. Customers almost
        // always keep the broader policy in practice.
        const mostExpensive = sortedAsc[sortedAsc.length - 1];
        const mostExpensiveCents =
          mostExpensive === undefined ? 0 : mostExpensive.monthly_cents;
        const savings = total - mostExpensiveCents;

        const names = insurance.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Line carries ${insurance.length} overlapping protection features`,
          description: `This line has multiple protection/insurance features (${names}) totaling ${formatCents(total)}/mo. Carrier protection plans generally don't stack — keeping more than one is almost always waste.`,
          recommended_action:
            'Pick the single most comprehensive plan and drop the others.',
          estimated_monthly_savings_cents: savings,
          confidence: 0.9,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            features: insurance.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            feature_names: insurance.map((f) => f.name),
            total_monthly_cents: total,
            most_expensive_monthly_cents: mostExpensiveCents,
            count: insurance.length,
          },
        });
      });
    });

    return findings;
  },
};
