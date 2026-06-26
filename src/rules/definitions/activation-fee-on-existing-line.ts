import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'activation_fee_on_existing_line';

// Carrier billing systems occasionally charge "activation" / "connection"
// fees on lines that have existed for many cycles — typically as a side
// effect of an upgrade transaction or a SIM swap that the carrier's system
// mis-categorized. These are almost always reversible on request.
const ACTIVATION_FEE_RE = /\b(activation|connection|sim\s*setup|upgrade)\s+fee\b/i;

// Signal that the line is established: at least one DPP has had at least
// one payment posted. (remaining_payments < total_payments AND total > 0).
function hasExistingDpp(line: import('@/extraction/schema').ExtractedLine): boolean {
  return line.dpp_installments.some((d) => {
    if (d.total_payments === null || d.remaining_payments === null) return false;
    return d.total_payments > 0 && d.remaining_payments < d.total_payments;
  });
}

export const activationFeeOnExistingLineRule: Rule = {
  id: RULE_ID,
  title: 'Activation / connection fee billed on an existing line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const activationFeatures = line.features.filter((f) => ACTIVATION_FEE_RE.test(f.name));
        if (activationFeatures.length === 0) return;
        if (!hasExistingDpp(line)) return;

        const total = activationFeatures.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = activationFeatures.map((f) => f.name).join(', ');
        // H1: activation/connection/SIM-setup/upgrade fees are ONE-TIME
        // charges, not monthly. Carrying the dollar amount in
        // `estimated_monthly_savings_cents` would let the audit-completed
        // rollup annualize it 12x (mark-completed at
        // src/inngest/functions/process-bill.ts:672-676). Surface the
        // amount in the user-visible copy + evidence, but emit 0 to the
        // headline rollup. `evidence.one_time_savings_cents` is the
        // canonical place to read the dollar figure.
        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Activation/connection fee on an established line`,
          description: `This line carries a one-time activation/connection-style charge (${names}, ${formatCents(total)}) despite having an established device-payment-plan history (at least one paid installment on file). These fees are almost always reversible on a single rep-call when the line is not actually newly activated. (One-time credit; not added to monthly savings.)`,
          recommended_action:
            'Call the carrier and request the activation/connection fee be credited back. Reference the established DPP history when escalating; reps will typically credit on first contact.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            feature_names: activationFeatures.map((f) => f.name),
            total_fee_cents: total,
            one_time_savings_cents: total,
            line_has_existing_dpp: true,
          },
        });
      });
    });

    return findings;
  },
};
