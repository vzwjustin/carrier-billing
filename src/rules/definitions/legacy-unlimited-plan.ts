import type { Rule, Finding } from '../types';
import { findMatchingLegacyPlan, formatCents } from '../helpers';

const RULE_ID = 'legacy_unlimited_plan';

// Confidence is heuristic: regex name match alone cannot prove a plan is
// grandfathered (carriers occasionally re-use names). We surface as 'low'
// severity so the auditor confirms before recommending migration.

export const legacyUnlimitedPlanRule: Rule = {
  id: RULE_ID,
  title: 'Line is on a deprecated/legacy plan',
  appliesTo: 'all',
  evaluate: ({ bill, carrier }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const match = findMatchingLegacyPlan(line.plan_name, carrier);
        if (match === null) return;

        // M5: when the carrier is unknown, findMatchingLegacyPlan returns
        // any match across the union of all carriers' patterns. That can
        // recommend a Verizon replacement_plan against an AT&T-shaped legacy
        // name. Drop the specific replacement_plan recommendation in that
        // case and let the customer / auditor pick the right successor.
        const isCrossCarrierGuess = carrier === 'unknown';
        const recommendedAction = isCrossCarrierGuess
          ? `Migrate this line off "${line.plan_name}" to your carrier's current business unlimited tier. Confirm the carrier (the bill header was ambiguous to the extractor) before quoting a specific replacement plan. Estimated conservative savings: ${formatCents(match.estimated_monthly_savings_cents)}/mo per line.`
          : `Migrate this line to ${match.replacement_plan} (or equivalent current tier). Quote the new tier including any line-discount band; migrate when the math is favorable. Estimated conservative savings: ${formatCents(match.estimated_monthly_savings_cents)}/mo per line.`;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Line is on legacy plan "${line.plan_name}"`,
          description: `The plan "${line.plan_name}" appears to be a deprecated/legacy tier that has been superseded by current business unlimited plans. Legacy tiers often cost more per line and lack newer perks (5G UW/UC inclusion, modern hotspot allotments, premium streaming).`,
          recommended_action: recommendedAction,
          estimated_monthly_savings_cents: match.estimated_monthly_savings_cents,
          // Lower confidence on the cross-carrier-guess case since we
          // matched a pattern from a carrier we couldn't otherwise verify.
          confidence: isCrossCarrierGuess ? 0.5 : 0.75,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            carrier,
            replacement_plan: isCrossCarrierGuess ? null : match.replacement_plan,
            source_note: match.source_note,
            cross_carrier_guess: isCrossCarrierGuess,
          },
        });
      });
    });

    return findings;
  },
};
