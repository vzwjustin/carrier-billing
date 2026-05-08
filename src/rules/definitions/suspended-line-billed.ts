import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'suspended_line_billed';

export const suspendedLineBilledRule: Rule = {
  id: RULE_ID,
  title: 'Suspended line is still being billed for service',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (!line.is_suspended) return;
        const planBase = line.plan_base_cents ?? 0;
        if (planBase <= 0) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'high',
          title: 'Suspended line still has a plan charge',
          description: `Line is marked suspended but is still being charged ${formatCents(planBase)}/mo for plan access. Suspended lines should typically be at zero or a minimal seasonal rate.`,
          recommended_action:
            'Decide whether to cancel the line outright (eliminating the charge) or move it to the carrier’s no-cost / vacation suspension tier.',
          estimated_monthly_savings_cents: planBase,
          // Very high confidence: bill explicitly marks the line suspended
          // AND charges a non-zero plan amount. There is no ambiguity here.
          confidence: 0.97,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            is_suspended: true,
          },
        });
      });
    });

    return findings;
  },
};
