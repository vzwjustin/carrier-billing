import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'feature_first_seen';

// Marketing-flavored feature-name patterns that often indicate an opt-in
// upsell SOC (Service Order Code) the customer may not remember subscribing
// to. "+1" matches Verizon's "Plus 1"/"+1" branded extras as well as the
// literal token. We do NOT catch dedicated categories here (insurance,
// international, hotspot, cloud) — those have purpose-built rules. Only
// `other`-category features are considered.
const MARKETING_NAME_RE = /\b(premium|boost|rewards?|perks?|\+\s*1|plus\s*1)\b/i;

/**
 * A paid `other`-category feature whose name matches a marketing-upsell
 * pattern ("premium", "boost", "rewards", "perks", "+1"). These are the kind
 * of opt-in SOCs that get attached at activation and never reviewed — not
 * always waste, but always worth a human-review pass.
 *
 * This is intentionally a low-severity / low-confidence "review me" rule.
 * The shipped extraction taxonomy puts well-understood categories (insurance,
 * international, cloud, hotspot) into their own buckets — anything still
 * labeled `other` is the long tail where the LLM couldn't classify, which
 * is exactly the population most likely to contain forgotten extras.
 */
export const featureFirstSeenRule: Rule = {
  id: RULE_ID,
  title: 'Unfamiliar paid feature worth reviewing',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const flagged = line.features.filter((f) => {
          if (f.category !== 'other') return false;
          if (f.monthly_cents <= 0) return false;
          return MARKETING_NAME_RE.test(f.name);
        });
        if (flagged.length === 0) return;

        const total = flagged.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = flagged.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Paid add-on(s) on this line worth a human review`,
          description: `This line carries ${flagged.length === 1 ? 'a paid feature' : `${flagged.length} paid features`} (${names}) totaling ${formatCents(total)}/mo whose name matches the carrier's marketing-upsell pattern. These SOCs are commonly attached at activation and forgotten — they may or may not still be needed.`,
          recommended_action:
            'Review with the line owner whether the listed add-on(s) are still in use. If not, ask your carrier rep to remove the SOC and request a back-credit for unused months.',
          estimated_monthly_savings_cents: total,
          // L1-equivalent: marketing pattern + paid + other-category is a
          // soft signal. "Likely" bucket per types.ts.
          confidence: 0.6,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            features: flagged.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            total_monthly_cents: total,
          },
        });
      });
    });

    return findings;
  },
};
