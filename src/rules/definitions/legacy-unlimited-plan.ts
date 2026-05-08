import type { Rule, Finding } from '../types';
import { getCarrierPlanPatterns, isPlanNameDeprecated } from '../helpers';

const RULE_ID = 'legacy_unlimited_plan';

// TODO(domain): Justin to validate regex set + add savings model when
// modern-equivalent plan price is known per carrier. Today we only flag
// matches; we don't try to estimate the savings of moving to a current-tier
// plan because that varies by line count and discount stack.

export const legacyUnlimitedPlanRule: Rule = {
  id: RULE_ID,
  title: 'Line is on a deprecated/legacy plan',
  appliesTo: 'all',
  evaluate: ({ bill, carrier }) => {
    const findings: Finding[] = [];

    // Use the carrier-specific pattern set when known; for 'unknown' bills
    // helpers.getCarrierPlanPatterns returns the union of all sets.
    const patterns = getCarrierPlanPatterns(carrier);
    if (patterns.length === 0) return findings;

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (!isPlanNameDeprecated(line.plan_name, patterns)) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Line is on legacy plan "${line.plan_name}"`,
          description: `The plan "${line.plan_name}" appears to be a deprecated/legacy tier that has been superseded by current business unlimited plans. Legacy tiers often cost more per line and lack newer perks (5G UW/UC inclusion, modern hotspot allotments, premium streaming).`,
          recommended_action:
            'Quote the current business unlimited tier from this carrier and compare total cost per line including any line-discount tiers. Migrate when the math is favorable.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.65,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            carrier,
          },
        });
      });
    });

    return findings;
  },
};
