import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'activation_fee_outsized';

// Matches "activation fee" and "upgrade ... fee" — the two SOC families that
// most often appear at amounts above the rep-quoted ceiling. Intentionally
// distinct from `activation_fee_on_existing_line` (which targets the
// fee-on-an-old-line case regardless of dollar amount); this rule targets the
// fee-amount case regardless of line tenure.
const ACTIVATION_NAME_RE = /\b(activation|upgrade.*fee)\b/i;
// $35 is the published activation/upgrade fee ceiling across Verizon Wireless
// Business, AT&T Business, and T-Mobile for Business as of late 2025. Amounts
// above this are almost always either a stack of two fees on one line or a
// "premium" tier the rep can usually waive.
const FEE_THRESHOLD_CENTS = 3500;

/**
 * A single line feature whose name matches an activation/upgrade-fee pattern
 * AND whose monthly_cents exceeds $35. This is the "outsized amount" branch
 * of activation-fee detection — distinct from
 * `activation_fee_on_existing_line` which targets fees on established lines
 * regardless of amount.
 *
 * The activation fee is a one-time charge but is reported as a single bill
 * cycle's `monthly_cents`. Conservative posture: surface the credit value in
 * evidence + copy but DO NOT roll it into `estimated_monthly_savings_cents`
 * (which downstream code annualizes 12× — same posture as
 * `activation_fee_on_existing_line`).
 */
export const activationFeeOutsizedRule: Rule = {
  id: RULE_ID,
  title: 'Activation or upgrade fee above the carrier-published ceiling',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const outsized = line.features.filter(
          (f) =>
            ACTIVATION_NAME_RE.test(f.name) &&
            f.monthly_cents > FEE_THRESHOLD_CENTS,
        );
        if (outsized.length === 0) return;

        const total = outsized.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = outsized.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Activation/upgrade fee charged at ${formatCents(total)} (above $35 ceiling)`,
          description: `This line carries an activation/upgrade-style charge (${names}) of ${formatCents(total)} this cycle, above the published ${formatCents(FEE_THRESHOLD_CENTS)} ceiling that all three major US business carriers list for new activations and device upgrades. Reps will almost always waive or back-credit the excess on request — and on enterprise accounts will often waive the full fee.`,
          recommended_action:
            'Ask your carrier rep to waive or credit back the activation/upgrade fee. Reference the carrier\'s published $35 cap for business activations when escalating; this is a routine first-contact credit.',
          // One-time charge. Stays at 0 in the monthly rollup so the audit
          // summary doesn't annualize a one-time fee into a recurring saving.
          // Operator sees the dollar figure in evidence + copy.
          estimated_monthly_savings_cents: 0,
          // High confidence per Buckets convention (> 0.8): the regex match
          // plus the bright-line $35 ceiling is a clear, well-documented signal.
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            features: outsized.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            total_fee_cents: total,
            one_time_savings_cents: total,
            threshold_cents: FEE_THRESHOLD_CENTS,
          },
        });
      });
    });

    return findings;
  },
};
