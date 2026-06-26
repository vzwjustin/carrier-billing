import type { Rule } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'bill_increase_over_threshold_in_total';

// Bill is considered "high" when actual total_charges_cents exceeds a
// component-derived baseline by more than this fraction. 15% covers a band
// wide enough to absorb typical taxes-and-fees + DPP variance on a normal
// account, while still surfacing genuinely outsized totals.
const OVER_THRESHOLD = 0.15;
// Min line count required before this sanity check fires. With 1–2 lines the
// expected baseline is too coarse — proration, mid-cycle activations and
// account-level adjustments easily dominate, producing noisy false positives.
// See snapshot fixture (`tests/rules/runner.test.ts`) which has 2 lines and
// must NOT trigger this rule.
const MIN_TOTAL_LINES = 3;
// Min absolute total to bother evaluating. A $5 final-cycle stub with $1
// component sum will trip the percentage check but isn't actionable.
const MIN_TOTAL_CENTS = 5000;

/**
 * Sanity-check rule: compares the bill's printed `total_charges_cents` to a
 * baseline computed entirely from line-level components present in the same
 * bill (no prior-bill context — rules don't have it). When the printed total
 * is more than 15% above the component sum, surface as an informational
 * "double-check the bill total" hint.
 *
 * Baseline = Σ(line plan_base + features + credits + dpp) + Σ(account credits)
 *          + Σ(account taxes_fees)
 *
 * Confidence is intentionally ~0.5 (Speculative bucket per types.ts): there
 * are legitimate reasons for a positive gap (one-time charges, regulatory
 * recovery items the parser didn't enumerate per-line) so this is a
 * "worth-a-look" rather than a confirmed waste finding. Severity stays
 * `info` and savings stays 0 — surfacing for human-review only.
 */
export const billIncreaseOverThresholdInTotalRule: Rule = {
  id: RULE_ID,
  title: 'Bill total noticeably higher than line-component sum',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const total = bill.total_charges_cents;
    if (total < MIN_TOTAL_CENTS) return [];

    let lineCount = 0;
    let componentSum = 0;
    for (const account of bill.accounts) {
      for (const line of account.lines) {
        lineCount += 1;
        componentSum += line.plan_base_cents ?? 0;
        for (const f of line.features) componentSum += f.monthly_cents;
        for (const c of line.credits) componentSum += c.monthly_cents;
        for (const d of line.dpp_installments) componentSum += d.monthly_cents;
      }
      for (const c of account.account_level_credits) {
        componentSum += c.monthly_cents;
      }
      componentSum += account.taxes_fees_cents ?? 0;
    }

    if (lineCount < MIN_TOTAL_LINES) return [];
    if (componentSum <= 0) return [];

    const excess = total - componentSum;
    if (excess <= 0) return [];
    const ratio = excess / componentSum;
    if (ratio <= OVER_THRESHOLD) return [];

    return [
      {
        rule_id: RULE_ID,
        severity: 'info',
        title: `Bill total ${(ratio * 100).toFixed(0)}% above sum of line components`,
        description: `The printed bill total is ${formatCents(total)} but the sum of all per-line components (plan + features + credits + device-payments) plus account-level credits and taxes/fees comes to only ${formatCents(componentSum)} — a gap of ${formatCents(excess)} (${(ratio * 100).toFixed(0)}% above). This is bill-internal-only (no prior-bill comparison) and most commonly indicates one-time charges, regulatory-recovery items the parser didn't enumerate, or an account-level adjustment that's worth confirming.`,
        recommended_action:
          'Compare the printed bill total to the line-item totals on the bill summary page. If the gap is from one-time charges (activation, upgrade, prorated changes), document them. If you cannot account for the gap, ask your carrier rep to walk through the bill summary line-by-line.',
        // Sanity-check, never rolled into savings — no recurring saving claim.
        estimated_monthly_savings_cents: 0,
        // Speculative bucket (< 0.5) per types.ts. This rule is a "trust the
        // total less" nudge for the operator, not a savings claim.
        confidence: 0.5,
        affected_line_indexes: [],
        affected_account_indexes: [],
        evidence: {
          total_charges_cents: total,
          component_sum_cents: componentSum,
          excess_cents: excess,
          ratio: Number(ratio.toFixed(3)),
          threshold: OVER_THRESHOLD,
          line_count: lineCount,
        },
      },
    ];
  },
};
