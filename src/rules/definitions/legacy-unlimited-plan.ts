import type { Rule, Finding } from '../types';
import { isPlanNameDeprecated } from '../helpers';

const RULE_ID = 'legacy_unlimited_plan';

// TODO(domain): Justin to provide refined regex set + savings model per
// carrier. Today we only flag obvious legacy names; we don't try to estimate
// the savings of moving to a current-tier plan because that varies by line
// count and discount stack.
const LEGACY_PLAN_PATTERNS: RegExp[] = [
  /More\s*Everything/i,
  /Verizon\s+Plan\s+Unlimited/i,
  /AT&T\s+Mobile\s+Share/i,
  /Simple\s+Choice/i,
];

export const legacyUnlimitedPlanRule: Rule = {
  id: RULE_ID,
  title: 'Line is on a deprecated/legacy plan',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (!isPlanNameDeprecated(line.plan_name, LEGACY_PLAN_PATTERNS)) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Line is on legacy plan "${line.plan_name}"`,
          description: `The plan "${line.plan_name}" appears to be a deprecated/legacy tier that has been superseded by current business unlimited plans. Legacy tiers often cost more per line and lack newer perks.`,
          recommended_action:
            'Quote the current business unlimited tier from this carrier and compare total cost per line including any line-discount tiers. Migrate when the math is favorable.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.6,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
          },
        });
      });
    });

    return findings;
  },
};
