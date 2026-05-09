import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'completed_device_payment_still_billed';

export const completedDevicePaymentRule: Rule = {
  id: RULE_ID,
  title: 'Completed device payment plan still being billed',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        line.dpp_installments.forEach((dpp) => {
          // Trust the extracted `remaining_payments` value: if extraction
          // reports it, that's the authoritative count. `total_payments` is
          // captured for evidence only — we don't try to derive remaining
          // from it (the previous "total - (total - remaining)" check was
          // algebraically just `remaining` and added no signal).
          //
          // When `remaining_payments` is null we have no positive signal
          // that the plan is complete — do NOT fire. Surfacing this as a
          // "review me" finding produced too many false positives in early
          // testing (carriers often print DPP rows for active plans without
          // an explicit count). Better to miss than to mis-flag.
          const remaining = dpp.remaining_payments;
          if (remaining === null) return;
          if (remaining !== 0) return;
          if (dpp.monthly_cents <= 0) return;

          findings.push({
            rule_id: RULE_ID,
            severity: 'high',
            title: `Device payment for "${dpp.device}" is complete but still billing`,
            description: `The device payment plan for ${dpp.device} shows ${dpp.total_payments ?? 'all'} payments completed, yet ${formatCents(dpp.monthly_cents)}/mo is still being charged. This is one of the most common forms of wireless waste.`,
            recommended_action:
              'Open a billing dispute with the carrier to remove the residual installment and request a credit for any past months billed after completion.',
            estimated_monthly_savings_cents: dpp.monthly_cents,
            confidence: 0.9,
            affected_line_indexes: [lineIndex],
            affected_account_indexes: [accountIndex],
            evidence: {
              device: dpp.device,
              monthly_cents: dpp.monthly_cents,
              remaining_payments: dpp.remaining_payments,
              total_payments: dpp.total_payments,
            },
          });
        });
      });
    });

    return findings;
  },
};
