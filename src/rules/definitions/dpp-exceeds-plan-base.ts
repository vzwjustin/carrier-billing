import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'dpp_exceeds_plan_base';

/**
 * The line's active device-payment monthly total exceeds the line's plan
 * base — a high-end phone on a low/mid plan. Often a sign that the line
 * could be consolidated onto a premium-tier plan that bundles a stronger
 * device-promo credit (most carriers tie their biggest installment credits
 * to the top-tier business plans), turning a "pay the full DPP + low plan"
 * structure into "lower DPP after promo + higher plan" with a net win.
 *
 * Intentionally low-severity / "likely" confidence: this is a structural
 * smell, not a definite waste — sometimes a customer is mid-promo and
 * already getting the best deal. The finding is meant to surface candidates
 * for a sales-rep conversation, not to claim a guaranteed saving (which is
 * why estimated_monthly_savings_cents is 0).
 */
export const dppExceedsPlanBaseRule: Rule = {
  id: RULE_ID,
  title: 'Device payment exceeds plan base on the same line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.dpp_installments.length === 0) return;

        // Only count DPPs that are still actively billing. A null
        // remaining_payments is treated as active (we have no positive
        // signal of completion). A zero is handled by
        // `completed_device_payment_still_billed`.
        const activeDpps = line.dpp_installments.filter(
          (d) => d.remaining_payments !== 0 && d.monthly_cents > 0,
        );
        if (activeDpps.length === 0) return;

        const dppTotal = activeDpps.reduce((sum, d) => sum + d.monthly_cents, 0);
        const planBase = line.plan_base_cents ?? 0;
        if (planBase <= 0) return;
        if (dppTotal <= planBase) return;

        const ratio = dppTotal / planBase;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Device payment (${formatCents(dppTotal)}/mo) exceeds plan base (${formatCents(planBase)}/mo)`,
          description: `This line's active device installment total of ${formatCents(dppTotal)}/mo is ${ratio.toFixed(1)}x its ${formatCents(planBase)}/mo plan base. A high-end device on a low/mid plan often qualifies for a larger installment-credit promo by moving to a premium-tier plan — the higher plan cost can be more than offset by the deeper device credit over the remaining DPP term.`,
          recommended_action:
            'Ask your carrier rep to model the cost delta of moving this line to a premium plan tier that carries a larger installment-credit promo. If the per-month credit increase exceeds the plan cost increase, switch and request a back-credit.',
          // Conservative: we cannot quantify the savings without modeling
          // promo eligibility and the customer's remaining term. Surface
          // the opportunity but don't claim a savings figure.
          estimated_monthly_savings_cents: 0,
          // "Likely" bucket: structural pattern is real, but every plan/promo
          // combo is different so this is not a confident savings claim.
          confidence: 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            dpp_total_cents: dppTotal,
            ratio: Number(ratio.toFixed(2)),
            active_dpp_count: activeDpps.length,
            devices: activeDpps.map((d) => d.device),
          },
        });
      });
    });

    return findings;
  },
};
