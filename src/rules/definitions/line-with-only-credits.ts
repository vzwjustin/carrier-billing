import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'line_with_only_credits';

/**
 * A non-suspended line whose net monthly cost
 * (plan_base + features + credits) is <= 0 AND has at least one credit
 * present. Two scenarios cover this pattern:
 *
 *  1. Credit-only placeholder — the line was canceled but the carrier
 *     left a phantom row that nets out via a corresponding credit. This is
 *     a carrier-accounting quirk that won't change the bill amount today,
 *     but should be cleaned up so the line count reflects reality (matters
 *     for line-count-based plan discount bands).
 *  2. Outstanding promo credit that no longer maps to anything — typically
 *     a credit that should have expired with a now-canceled service but
 *     keeps applying. Operator should confirm with the rep that the credit
 *     belongs on the account.
 *
 * Suspended lines are excluded — those are handled by
 * `suspended_line_billed`. The estimated savings is 0 because the net
 * impact today is zero or negative (the line is "free"); the value is in
 * cleaning up the accounting + checking nothing was misrouted.
 */
export const lineWithOnlyCreditsRule: Rule = {
  id: RULE_ID,
  title: 'Line nets to zero or negative — credits offset all charges',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        if (line.credits.length === 0) return;

        const planBase = line.plan_base_cents ?? 0;
        const featuresTotal = line.features.reduce(
          (sum, f) => sum + f.monthly_cents,
          0,
        );
        const creditsTotal = line.credits.reduce(
          (sum, c) => sum + c.monthly_cents,
          0,
        );
        const net = planBase + featuresTotal + creditsTotal;
        if (net > 0) return;

        // Skip the trivial case where the only "charges" are themselves zero
        // — a $0 plan with a $0 credit isn't an accounting quirk worth
        // flagging. Require at least one nonzero charge or credit.
        if (planBase === 0 && featuresTotal === 0 && creditsTotal === 0) {
          return;
        }

        findings.push({
          rule_id: RULE_ID,
          severity: 'info',
          title: 'Line nets to zero — credits offset all charges',
          description: `This active line has ${formatCents(planBase + featuresTotal)} in monthly charges (plan + features) and ${formatCents(Math.abs(creditsTotal))} in monthly credits, netting to ${formatCents(net)}/mo. Either the line is a credit-only placeholder left after a cancellation, or a promo credit is still applying after the underlying service was removed.`,
          recommended_action:
            'Ask the carrier rep to confirm this line should still exist on the account. If it should not, request the line be removed and the offsetting credit closed out — phantom lines can affect line-count-based plan discount bands.',
          // Net is 0 today; no monthly savings to claim. Surfaced for
          // accounting hygiene + line-count integrity.
          estimated_monthly_savings_cents: 0,
          // "Likely" bucket: structural pattern is clear, but legitimate
          // (e.g. an upgrade-promo credit running its full 36-month course
          // on a low-base plan can net to zero).
          confidence: 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_base_cents: planBase,
            features_total_cents: featuresTotal,
            credits_total_cents: creditsTotal,
            net_cents: net,
            credit_count: line.credits.length,
          },
        });
      });
    });

    return findings;
  },
};
