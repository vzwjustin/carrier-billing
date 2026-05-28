import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'account_total_mismatch';

// Bill totals legitimately drift from the component sum by a small amount
// (rounding, line-item credits the parser puts in a different slot, etc).
// Only flag when the gap is BOTH > $1 AND > 1% of the account total — a
// double gate keeps the rule quiet on both very small accounts (where $1
// is meaningful but 1% is tiny) and very large accounts (where 1% is
// meaningful but $1 is rounding noise).
const ABSOLUTE_THRESHOLD_CENTS = 100;
const RATIO_THRESHOLD = 0.01;
// Skip accounts with < this many lines. The snapshot fixture has 2 lines on
// 1 account and intentionally does not satisfy this gate — on tiny accounts
// proration and per-line adjustments dominate the math, producing noisy
// false positives that aren't actionable.
const MIN_LINES_PER_ACCOUNT = 3;

/**
 * Per-account sanity check: the printed `total_charges_cents` should be
 * close to the sum of (per-line plan_base + features + credits + dpp) +
 * account-level credits + taxes/fees. Significant divergence is a
 * parser-quality smell (or, occasionally, a one-time charge bucket that
 * never made it into a line item) worth surfacing.
 *
 * Severity `info`, confidence 0.6 ("Likely" bucket). Estimated savings is
 * 0 — this rule is a data-quality signal, not a waste finding.
 */
export const accountTotalMismatchRule: Rule = {
  id: RULE_ID,
  title: 'Account total does not reconcile to the sum of line components',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      if (account.lines.length < MIN_LINES_PER_ACCOUNT) return;
      const total = account.total_charges_cents;
      if (total <= 0) return;

      let componentSum = 0;
      for (const line of account.lines) {
        componentSum += line.plan_base_cents ?? 0;
        for (const f of line.features) componentSum += f.monthly_cents;
        for (const c of line.credits) componentSum += c.monthly_cents;
        for (const d of line.dpp_installments) componentSum += d.monthly_cents;
      }
      for (const c of account.account_level_credits) {
        componentSum += c.monthly_cents;
      }
      componentSum += account.taxes_fees_cents ?? 0;

      const diff = Math.abs(total - componentSum);
      if (diff <= ABSOLUTE_THRESHOLD_CENTS) return;
      const ratio = diff / total;
      if (ratio <= RATIO_THRESHOLD) return;

      const direction = total > componentSum ? 'higher than' : 'lower than';

      findings.push({
        rule_id: RULE_ID,
        severity: 'info',
        title: `Account total (${formatCents(total)}) does not reconcile to line components (${formatCents(componentSum)})`,
        description: `The account's printed total is ${formatCents(total)} but the sum of all per-line components plus account credits and taxes/fees comes to ${formatCents(componentSum)} — a gap of ${formatCents(diff)} (${(ratio * 100).toFixed(1)}% of the total), which is ${direction} expected. This is most often a parser-quality smell (a line-item or surcharge row didn't get attached to the right slot) rather than a missed charge, but operators should confirm before relying on the per-line totals.`,
        recommended_action:
          'Compare the printed account summary to the line-item totals on the bill. If the gap is from line items the parser missed (often "Other charges and credits" or surcharge sub-buckets), re-upload the bill once the PDF includes the full surcharge detail page. If the gap persists, treat per-line numbers as approximate.',
        // Parser-quality smell. Never rolled into savings.
        estimated_monthly_savings_cents: 0,
        // "Likely" bucket lower end per types.ts. The signal is structural
        // and meaningful but has multiple benign explanations (rounding,
        // bucket-misallocation by the extractor).
        confidence: 0.6,
        affected_line_indexes: [],
        affected_account_indexes: [accountIndex],
        evidence: {
          total_charges_cents: total,
          component_sum_cents: componentSum,
          diff_cents: diff,
          ratio: Number(ratio.toFixed(3)),
          absolute_threshold_cents: ABSOLUTE_THRESHOLD_CENTS,
          ratio_threshold: RATIO_THRESHOLD,
          direction: total > componentSum ? 'over' : 'under',
        },
      });
    });

    return findings;
  },
};
