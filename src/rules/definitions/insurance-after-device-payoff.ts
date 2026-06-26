import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'insurance_after_device_payoff';

/**
 * "I paid off my phone two years ago but I'm still paying $13/mo for the
 * Asurion plan I added at activation." Pairs with `completed_device_payment`
 * (which catches the unpaid-after-payoff DPP billing artifact) — this rule
 * catches the related but separate waste where the DPP is correctly at 0
 * but the protection plan attached to it was never canceled.
 *
 * Trigger: line has at least one DPP entry with `remaining_payments === 0`
 * AND at least one insurance feature, AND the line is not suspended (a
 * suspended line is covered by `orphan_insurance`).
 */
export const insuranceAfterDevicePayoffRule: Rule = {
  id: RULE_ID,
  title: 'Insurance still billing after device payoff',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        const insurance = findFeatureByCategory(line, 'insurance');
        if (insurance.length === 0) return;

        const paidOff = line.dpp_installments.some((d) => d.remaining_payments === 0);
        if (!paidOff) return;

        const total = insurance.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = insurance.map((f) => f.name).join(', ');
        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Protection still billing after device payoff`,
          description: `This line has at least one device payment plan with no remaining installments (the phone is paid off) and is still being billed ${formatCents(total)}/mo for protection (${names}). Carrier protection plans typically add a flat monthly fee regardless of device age — once the device is paid off, the plan is often the largest single line item still tied to a sunk-cost device.`,
          recommended_action:
            'Evaluate whether protection is still justified for a paid-off device. If the phone would be replaced rather than repaired on damage, cancel the plan; otherwise consider downgrading to a lower tier.',
          estimated_monthly_savings_cents: total,
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            insurance_features: insurance.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            paid_off_dpp_count: line.dpp_installments.filter((d) => d.remaining_payments === 0)
              .length,
          },
        });
      });
    });

    return findings;
  },
};
